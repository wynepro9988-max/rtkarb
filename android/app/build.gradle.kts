import java.util.Properties

plugins {
    id("com.android.application")
}

val debugUrl = (project.findProperty("rtka.debugUrl") as String?)?.trim().orEmpty().ifEmpty { "http://10.0.2.2:3000" }
val releaseUrl = (project.findProperty("rtka.releaseUrl") as String?)?.trim().orEmpty()

// Penandatanganan rilis dibaca dari android/keystore.properties (tidak di-commit).
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "id.rtka.rumahbintang"
    compileSdk = 36

    defaultConfig {
        // ID aplikasi bersifat permanen setelah dipublikasikan — lihat docs/06-keputusan-terbuka.md.
        applicationId = "id.rtka.rumahbintang"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            buildConfigField("String", "BASE_URL", "\"$debugUrl\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "BASE_URL", "\"$releaseUrl\"")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// Build rilis ditolak bila alamat server bukan https.
tasks.configureEach {
    if (name == "preReleaseBuild") {
        doFirst {
            if (!releaseUrl.startsWith("https://")) {
                throw GradleException("Set -Prtka.releaseUrl=https://... (wajib HTTPS) untuk build rilis.")
            }
        }
    }
}
