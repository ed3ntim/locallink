plugins {
    kotlin("multiplatform") version "2.1.20"
}

group = "dev.salvo"
version = "0.1.0"

kotlin {
    // JVM ist das einzige Ziel, das hier auf Windows ohne weitere SDKs baut und
    // testet. Der gesamte Kern liegt in commonMain (reines Kotlin, keine
    // Plattform-APIs), sodass die folgenden Ziele spaeter nur eingehaengt
    // werden muessen - kein Code muss wandern:
    //   iosArm64(); iosSimulatorArm64()   // brauchen macOS
    //   androidTarget()                    // braucht das Android-SDK
    //   js(IR) { nodejs() }                // fuer einen Web-Build
    // kotlin("test") waehlt auf der JVM standardmaessig JUnit 4 - kein
    // useJUnitPlatform() noetig, das wuerde JUnit 5 erwarten und keine Tests finden.
    jvm()

    sourceSets {
        val commonMain by getting
        val commonTest by getting {
            dependencies {
                implementation(kotlin("test"))
            }
        }
    }
}
