fn main() {
    println!("cargo:rerun-if-changed=resources/localchat.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        if let Err(error) = winres::WindowsResource::new().set_icon("resources/localchat.ico").compile() {
            panic!("failed to embed LocalChat Windows icon: {error}");
        }
    }
}
