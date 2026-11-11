plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val sourceRevision = runCatching {
    val process = ProcessBuilder("git", "rev-parse", "--short=12", "HEAD")
        .directory(rootProject.projectDir).start()
    val revision = process.inputStream.bufferedReader().use { it.readText().trim() }
    if (process.waitFor() == 0 && revision.matches(Regex("[0-9a-f]{7,40}"))) revision else "unknown"
}.getOrDefault("unknown")

android {
    buildFeatures { buildConfig = true }
    namespace = "de.alex.sleeplogger"
    compileSdk = 35

    defaultConfig {
        applicationId = "de.alex.sleeplogger"
        minSdk = 30
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
        buildConfigField("String", "SOURCE_REVISION", "\"$sourceRevision\"")
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
