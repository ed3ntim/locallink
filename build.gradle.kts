plugins {
    kotlin("multiplatform") version "2.1.20"
    id("com.android.library") version "8.7.3"
}

group = "dev.salvo"
version = "0.1.0"

kotlin {
    // JVM: baut und testet ueberall, auch auf Windows ohne SDK.
    jvm()

    // Android: erzeugt die Bibliothek als .aar. Der gesamte Kern liegt in
    // commonMain, daher hat androidMain vorerst keinen eigenen Code - die
    // BLE-/WLAN-Transporte kommen spaeter per expect/actual dazu.
    androidTarget {
        compilations.all {
            compileTaskProvider.configure {
                compilerOptions {
                    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
                }
            }
        }
    }

    // Spaeter (brauchen macOS bzw. einen Web-Build):
    //   iosArm64(); iosSimulatorArm64(); js(IR) { nodejs() }

    sourceSets {
        val commonMain by getting
        val commonTest by getting {
            dependencies {
                implementation(kotlin("test"))
            }
        }
    }
}

android {
    namespace = "dev.salvo.locallink"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
