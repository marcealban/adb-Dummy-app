# Algoritmo de extracción de iconos Android

Este algoritmo describe el flujo para extraer el icono adaptable de una aplicación Android instalada en un dispositivo utilizando **ADB**, **AAPT2**, **Apktool** y **Sharp**. Los pasos incluyen variables parametrizables para que el proceso pueda reutilizarse con cualquier paquete.

## Variables principales

| Variable | Descripción | Ejemplo |
| --- | --- | --- |
| `[PACKAGE_NAME]` | Nombre del paquete de la app instalada. | `com.lemurbrowser.exts` |
| `[OUT_DIR]` | Carpeta temporal de trabajo. | `icono_lemur` |
| `[DEVICE_APK_PATH]` | Ruta del `base.apk` en el dispositivo. | `/data/app/.../base.apk` |
| `[DENSITY]` | Densidad de los recursos del icono. Se recomienda `xxhdpi`. | `xxhdpi` |
| `[CACHE_DIR]` | Carpeta de caché donde se almacenará el icono final. | `..\adb-Dummy-app_cache_iconos` |

> **Nota:** En el ejemplo se usa `adb-Dummy-app_cache_iconos` como nombre de caché únicamente a modo ilustrativo. En la aplicación final debe emplearse la ruta real de la caché de iconos.

## Procedimiento

1. **Crear la carpeta de trabajo**
   ```bat
   mkdir [OUT_DIR] && cd [OUT_DIR]
   ```
2. **Listar los APK del paquete**
   ```bat
   "..\adb.exe" shell pm path [PACKAGE_NAME]
   ```
3. **Descargar el `base.apk`**
   ```bat
   "..\adb.exe" pull [DEVICE_APK_PATH] base.apk
   ```
4. **Inspeccionar el APK con AAPT2**
   ```bat
   "..\aapt2.exe" dump badging base.apk
   ```
5. **Extraer el XML del adaptive icon**
   ```bat
   "..\aapt2.exe" dump xmltree --file [ICON_XML] base.apk
   ```
6. **Resolver recursos (IDs → nombres)**
   ```bat
   "..\aapt2.exe" dump resources base.apk | findstr /I [RESOURCE_ID]
   ```
7. **Descompilar el APK con Apktool**
   ```bat
   "..\jre_portable\bin\java.exe" -jar "..\apktool.jar" d -f base.apk -o base_decodificado
   ```
8. **Localizar los archivos `layered_app_icon`**
   ```bat
   dir base_decodificado\res\mipmap-anydpi\*layered_app_icon*.xml
   ```
9. **Copiar los XML principales**
   ```bat
   copy base_decodificado\res\mipmap-anydpi\layered_app_icon.xml .
   copy base_decodificado\res\mipmap-anydpi\layered_app_icon_round.xml .
   ```
10. **Copiar las capas de `background` y `foreground`**
    ```bat
    copy base_decodificado\res\mipmap-[DENSITY]\layered_app_icon_background.* .
    copy base_decodificado\res\mipmap-[DENSITY]\layered_app_icon_foreground.* .
    ```
11. **Componer el icono con Node.js y Sharp**
    ```bat
    node -e "const sharp=require('sharp');sharp('layered_app_icon_background').resize(512,512).composite([{input:'layered_app_icon_foreground',gravity:'center'}]).png().toFile('icono_final.png').then(()=>console.log('icono listo')).catch(e=>console.error(e))"
    ```
12. **Mover el icono a la caché**
    ```bat
    if not exist [CACHE_DIR] mkdir [CACHE_DIR]
    copy /Y "icono_final.png" "[CACHE_DIR]\[PACKAGE_NAME].png"
    ```
13. **Limpiar archivos temporales**
    ```bat
    cd ..
    rmdir /S /Q [OUT_DIR]
    ```

## Ejemplo práctico (Lemur Browser)

- `[PACKAGE_NAME]` → `com.lemurbrowser.exts`
- `[OUT_DIR]` → `icono_lemur`
- `[DEVICE_APK_PATH]` → `/data/app/.../com.lemurbrowser.exts-.../base.apk`
- `[DENSITY]` → `xxhdpi`
- `[CACHE_DIR]` → `..\adb-Dummy-app_cache_iconos`

### Flujo real de comandos

```bat
mkdir icono_lemur && cd icono_lemur
"..\adb.exe" shell pm path com.lemurbrowser.exts
"..\adb.exe" pull /data/app/.../base.apk base.apk
"..\aapt2.exe" dump badging base.apk
"..\aapt2.exe" dump xmltree --file res/xvk.xml base.apk
"..\aapt2.exe" dump resources base.apk | findstr /I "0x7f11001b 0x7f11001c"
"..\jre_portable\bin\java.exe" -jar "..\apktool.jar" d -f base.apk -o base_decodificado
dir base_decodificado\res\mipmap-anydpi\*layered_app_icon*.xml
copy base_decodificado\res\mipmap-anydpi\layered_app_icon.xml .
copy base_decodificado\res\mipmap-xxhdpi\layered_app_icon_background.* .
copy base_decodificado\res\mipmap-xxhdpi\layered_app_icon_foreground.* .
node -e "const sharp=require('sharp');sharp('layered_app_icon_background').resize(512,512).composite([{input:'layered_app_icon_foreground',gravity:'center'}]).png().toFile('icono_final.png').then(()=>console.log('icono listo')).catch(e=>console.error(e))"
if not exist "..\adb-Dummy-app_cache_iconos" mkdir "..\adb-Dummy-app_cache_iconos"
copy /Y "icono_final.png" "..\adb-Dummy-app_cache_iconos\com.lemurbrowser.exts.png"
cd .. && rmdir /S /Q icono_lemur
```
