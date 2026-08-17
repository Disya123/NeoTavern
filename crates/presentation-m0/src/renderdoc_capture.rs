//! Debug-only RenderDoc in-application capture around the measured D1a frame.
//!
//! Compiled only with feature `renderdoc-capture` on Android. Production
//! `libneotavern_android_jni.so` does not compile this module. The RenderDoc
//! shared library is **not** linked into the APK; `RENDERDOC_GetAPI` is
//! resolved from the already-injected capture layer.
//!
//! Header contract: vendored RenderDoc v1.45 `renderdoc_app.h` (MIT) at
//! `third_party/renderdoc_app.h`. Vulkan cannot pass raw `VkDevice` as the
//! in-app device pointer; `StartFrameCapture` / `EndFrameCapture` take
//! `RENDERDOC_DEVICEPOINTER_FROM_VKINSTANCE` of the wgpu-hal `VkInstance`
//! that owns the probe `VkDevice`. Passing `NULL` matches HWUI GLES.
//!
//! <https://renderdoc.org/docs/in_application_api.html>
//! <https://github.com/baldurk/renderdoc/blob/v1.x/renderdoc/api/app/renderdoc_app.h>

#![cfg(all(feature = "renderdoc-capture", target_os = "android"))]

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::ptr;

use ash::vk::Handle;
use wgpu::hal::api::Vulkan as VulkanApi;

use crate::gpu::probe_trace;

const RTLD_NOW: c_int = 2;
const RTLD_NOLOAD: c_int = 4;
const API_1_1_2: i32 = 10102;
const PATH_TEMPLATE: &str = "/data/data/com.neotavern.mobile/files/m0-d1a";

const MODULES: &[&str] = &[
    "libVkLayer_GLES_RenderDoc.so",
    "libVkLayer_RenderDoc.so",
    "librenderdoc.so",
];

#[link(name = "dl")]
extern "C" {
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

type GetApiFn = unsafe extern "C" fn(i32, *mut *mut c_void) -> i32;
type SetPathFn = unsafe extern "C" fn(*const c_char);
type StartFn = unsafe extern "C" fn(*mut c_void, *mut c_void);
type EndFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32;
type GetNumFn = unsafe extern "C" fn() -> u32;
type GetCaptureFn = unsafe extern "C" fn(u32, *mut c_char, *mut u32, *mut u64) -> u32;

/// Indices into `RENDERDOC_API_1_1_2` / later compatible structs.
const IDX_SET_PATH: usize = 11;
const IDX_GET_NUM: usize = 13;
const IDX_GET_CAPTURE: usize = 14;
const IDX_START: usize = 19;
const IDX_END: usize = 21;
const FN_COUNT: usize = 22;

#[repr(C)]
struct Api {
    fns: [*mut c_void; FN_COUNT],
}

/// wgpu-hal Vulkan handles for the probe device. `rdoc_device` is the
/// official RenderDoc capture key (instance dispatch table).
struct VulkanCapturePtrs {
    vk_device: u64,
    rdoc_device: *mut c_void,
}

pub struct FrameGuard {
    api: *const Api,
    rdoc_device: *mut c_void,
    started: bool,
}

fn load_module() -> *mut c_void {
    for name in MODULES {
        let Ok(c_name) = CString::new(*name) else {
            continue;
        };
        let handle = unsafe { dlopen(c_name.as_ptr(), RTLD_NOW | RTLD_NOLOAD) };
        if !handle.is_null() {
            return handle;
        }
    }
    ptr::null_mut()
}

fn attach_api() -> Option<*const Api> {
    let handle = load_module();
    if handle.is_null() {
        probe_trace("renderdoc_api_loaded=false");
        return None;
    }
    let symbol = CString::new("RENDERDOC_GetAPI").ok()?;
    let get_api = unsafe { dlsym(handle, symbol.as_ptr()) };
    if get_api.is_null() {
        probe_trace("renderdoc_api_loaded=false");
        return None;
    }
    let get_api: GetApiFn = unsafe { std::mem::transmute(get_api) };
    let mut out: *mut c_void = ptr::null_mut();
    let ok = unsafe { get_api(API_1_1_2, &mut out) };
    if ok != 1 || out.is_null() {
        probe_trace(&format!(
            "renderdoc_api_loaded=false getapi_failed ret={ok}"
        ));
        return None;
    }
    probe_trace("renderdoc_api_loaded=true");
    Some(out as *const Api)
}

/// Raw `VkDevice` plus RenderDoc's instance-dispatch pointer for that device.
///
/// Safety: `device` must outlive the returned pointers' use; the handles are
/// copied out of the HAL guard immediately.
fn vulkan_capture_ptrs(device: &wgpu::Device) -> Option<VulkanCapturePtrs> {
    unsafe {
        let hal = device.as_hal::<VulkanApi>()?;
        let vk_device = Handle::as_raw(hal.raw_device().handle());
        let vk_instance = Handle::as_raw(hal.shared_instance().raw_instance().handle());
        if vk_instance == 0 || vk_device == 0 {
            return None;
        }
        let instance_ptr = vk_instance as *mut *mut c_void;
        let rdoc_device = *instance_ptr;
        if rdoc_device.is_null() {
            return None;
        }
        Some(VulkanCapturePtrs {
            vk_device,
            rdoc_device,
        })
    }
}

impl FrameGuard {
    /// Start a capture bound to the probe's wgpu Vulkan device. Does not use
    /// a NULL/wildcard device pointer (that matches HWUI GLES).
    pub fn begin_for_device(device: &wgpu::Device) -> Option<Self> {
        Self::begin_for_device_path(device, PATH_TEMPLATE)
    }

    pub fn begin_for_device_path(device: &wgpu::Device, path_template: &str) -> Option<Self> {
        let api = attach_api()?;
        let Some(ptrs) = vulkan_capture_ptrs(device) else {
            probe_trace("capture_device=not-vulkan");
            probe_trace("capture_started=false");
            return None;
        };
        probe_trace(&format!(
            "capture_device=wgpu-vulkan vk_device=0x{:x}",
            ptrs.vk_device
        ));
        let set_path: SetPathFn = unsafe { std::mem::transmute((*api).fns[IDX_SET_PATH]) };
        if let Ok(path) = CString::new(path_template) {
            unsafe { set_path(path.as_ptr()) };
        }
        let start: StartFn = unsafe { std::mem::transmute((*api).fns[IDX_START]) };
        unsafe { start(ptrs.rdoc_device, ptr::null_mut()) };
        probe_trace("capture_started=true");
        Some(Self {
            api,
            rdoc_device: ptrs.rdoc_device,
            started: true,
        })
    }

    fn finish(&mut self) {
        if !self.started {
            return;
        }
        self.started = false;
        let end: EndFn = unsafe { std::mem::transmute((*self.api).fns[IDX_END]) };
        let saved = unsafe { end(self.rdoc_device, ptr::null_mut()) };
        let get_num: GetNumFn = unsafe { std::mem::transmute((*self.api).fns[IDX_GET_NUM]) };
        let n = unsafe { get_num() };
        let mut path_buf = [0u8; 512];
        let mut path_len: u32 = path_buf.len() as u32;
        if n > 0 {
            let get_cap: GetCaptureFn =
                unsafe { std::mem::transmute((*self.api).fns[IDX_GET_CAPTURE]) };
            let _ = unsafe {
                get_cap(
                    n - 1,
                    path_buf.as_mut_ptr().cast(),
                    &mut path_len,
                    ptr::null_mut(),
                )
            };
        }
        let path = CStr::from_bytes_until_nul(&path_buf)
            .ok()
            .and_then(|s| s.to_str().ok())
            .unwrap_or("");
        probe_trace(&format!(
            "capture_ended=true saved={saved} captures={n} capture_file={path}"
        ));
    }
}

impl Drop for FrameGuard {
    fn drop(&mut self) {
        self.finish();
    }
}
