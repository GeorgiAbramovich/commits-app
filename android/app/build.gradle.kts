import javax.inject.Inject

plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.georgiabramovich.commits"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.georgiabramovich.commits"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

dependencies {
    implementation("androidx.activity:activity:1.9.3")
    implementation("androidx.core:core:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.work:work-runtime:2.10.0")
}

// The web app in the repo root is the single source of truth: copy it into the APK's assets on every build.
abstract class CopyWebApp : DefaultTask() {
    @get:InputFiles abstract val sources: ConfigurableFileCollection
    @get:OutputDirectory abstract val outputDir: DirectoryProperty
    @get:Inject abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        fs.sync {
            from(sources)
            into(outputDir.dir("www"))
        }
    }
}

val copyWebApp = tasks.register<CopyWebApp>("copyWebApp") {
    sources.from(rootProject.layout.projectDirectory.dir("..").asFileTree.matching {
        include("index.html", "app.js", "style.css", "manifest.webmanifest", "icon.svg", "icon-*.png")
    })
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyWebApp, CopyWebApp::outputDir)
    }
}
