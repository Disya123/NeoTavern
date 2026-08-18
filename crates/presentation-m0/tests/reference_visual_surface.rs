#![cfg(feature = "gpu")]

use neotavern_neocompositor::{
    PresentSample, PresentationTime, ReferenceVisualSurfaceProducer, SurfaceFrameIngress,
    VisualSurfaceDeclare,
};
use neotavern_presentation_m0::gpu::ProbeGpu;

#[test]
fn reference_visual_surface_renders_through_ingress_or_skip() {
    match ProbeGpu::try_new_labeled(320, 200, neotavern_presentation_m0::gpu::LabelMode::Perf15) {
        Err(err) if err.is_no_adapter() => {
            eprintln!("SKIP: no wgpu adapter (not a PERF-15 PASS): {err}");
        }
        Err(err) => panic!("GPU init failed: {err}"),
        Ok(mut gpu) => {
            let mut ingress = SurfaceFrameIngress::new(gpu.device_epoch());
            let id = ingress
                .declare(VisualSurfaceDeclare::reference_pressure())
                .expect("declare");
            let mut producer = ReferenceVisualSurfaceProducer::new();
            producer.tick(PresentationTime::from_millis(0));
            let work = producer.take_latest().expect("work");
            let frame = gpu
                .render_reference_visual_surface(id, 1, &work)
                .expect("render mesh");
            ingress
                .submit(gpu.shared_gpu(), frame)
                .expect("ingress submit");
            match ingress.present_sample(id) {
                PresentSample::Ready(ready) => assert_eq!(ready.sequence, 1),
                other => panic!("{other:?}"),
            }
            assert!(ingress.surface_frame_ingress());
            assert!(!ingress.plugin_runtime());
            assert!(!ingress.direct_display_list_injection());
        }
    }
}
