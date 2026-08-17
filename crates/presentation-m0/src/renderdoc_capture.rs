//! Debug-only RenderDoc in-application capture around D1a submits.
//!
//! Loaded only when RenderDoc has already injected
//! `libVkLayer_GLES_RenderDoc.so` (Android Remote Context). Production
//! `libneotavern_android_jni.so` does not compile this module.
//!
//! Frame-trigger capture stops on the HWUI TextView present; the probe is
//! offscreen. `StartFrameCapture` / `EndFrameCapture` around the first
//! `render_list` is the documented headless capture boundary.
//!
//! Header contract: RenderDoc v1.45 `renderdoc_app.h` (MIT), API 1.1.2
//! function-pointer layout through `EndFrameCapture`.
//! <https://renderdoc.org/docs/in_application_api.html>

#![cfg(all(feature = "gpu", target_os = "android"))]

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::ptr;

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

pub struct FrameGuard {
    api: *const Api,
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
        probe_trace(
            "renderdoc_api=absent (layer not injected; launch via RenderDoc Remote Context)",
        );
        return None;
    }
    let symbol = CString::new("RENDERDOC_GetAPI").ok()?;
    let get_api = unsafe { dlsym(handle, symbol.as_ptr()) };
    if get_api.is_null() {
        probe_trace("renderdoc_api=no_RENDERDOC_GetAPI");
        return None;
    }
    let get_api: GetApiFn = unsafe { std::mem::transmute(get_api) };
    let mut out: *mut c_void = ptr::null_mut();
    let ok = unsafe { get_api(API_1_1_2, &mut out) };
    if ok != 1 || out.is_null() {
        probe_trace(&format!("renderdoc_api=getapi_failed ret={ok}"));
        return None;
    }
    Some(out as *const Api)
}

impl FrameGuard {
    pub fn begin() -> Option<Self> {
        let api = attach_api()?;
        let set_path: SetPathFn = unsafe { std::mem::transmute((*api).fns[IDX_SET_PATH]) };
        if let Ok(path) = CString::new(PATH_TEMPLATE) {
            unsafe { set_path(path.as_ptr()) };
        }
        let start: StartFn = unsafe { std::mem::transmute((*api).fns[IDX_START]) };
        unsafe { start(ptr::null_mut(), ptr::null_mut()) };
        probe_trace("renderdoc_api=start_frame_capture");
        Some(Self { api, started: true })
    }

    fn finish(&mut self) {
        if !self.started {
            return;
        }
        self.started = false;
        let end: EndFn = unsafe { std::mem::transmute((*self.api).fns[IDX_END]) };
        let saved = unsafe { end(ptr::null_mut(), ptr::null_mut()) };
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
            "renderdoc_api=end_frame_capture saved={saved} captures={n} path={path}"
        ));
    }
}

impl Drop for FrameGuard {
    fn drop(&mut self) {
        self.finish();
    }
}
