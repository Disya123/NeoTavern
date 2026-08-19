import org.gradle.api.GradleException
import org.gradle.api.tasks.Copy

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Production web UI staged from apps/web/dist into APK assets/web/ (ТЗ §11.4).
// JVM unit tests do NOT depend on this task (no merge*Assets), so they stay
// runnable without a Vite build. assembleDebug / connectedAndroidTest fail
// closed if index.html is missing (ТЗ §18.3).
val webDistDir = rootProject.projectDir.resolve("../web/dist")
val packagedWebAssetsDir = layout.buildDirectory.dir("generated/neotavern-web-assets")

val packageWebAssets by tasks.registering(Copy::class) {
    group = "build"
    description = "Stage apps/web/dist into APK assets/web (ТЗ §11.4 / §18.3)."
    from(webDistDir)
    into(packagedWebAssetsDir.map { it.dir("web") })
    doFirst {
        val index = webDistDir.resolve("index.html")
        if (!index.isFile) {
            throw GradleException(
                "Refusing to package an Android APK without apps/web/dist/index.html " +
                    "(ТЗ §11.4 / §18.3). Build the web client first: " +
                    "`pnpm --filter @neotavern/web build`",
            )
        }
    }
}

android {
    namespace = "com.neotavern.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.neotavern.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets.getByName("main").assets.srcDir(packagedWebAssetsDir)

    // CI `assembleRelease` uses the debug keystore so the ZIP can be
    // scanned for packaged web assets (ТЗ §11.4 Packaged). Store signing
    // is the release gate, not this host module.
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = false
        }
    }

    // The native kernel library (libneotavern_android_jni.so) and the
    // guarded presentation chat library (libneotavern_presentation_chat.so)
    // are PREBUILT artifacts in src/main/jniLibs/{arm64-v8a,x86_64}/ —
    // they are never committed and need no externalNativeBuild configuration.
    // Probe libs stay in src/debug/jniLibs/. WebView remains in the APK.
}

tasks.configureEach {
    val n = name
    if (
        n == "mergeDebugAssets" ||
            n == "mergeReleaseAssets" ||
            n.contains("lintVital", ignoreCase = true)
    ) {
        dependsOn(packageWebAssets)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.1")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
}
