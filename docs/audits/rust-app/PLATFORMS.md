# РџР»Р°С‚С„РѕСЂРјС‹, РІРІРѕРґ Рё РЅР°С‚РёРІРЅС‹Р№ СЂРµРЅРґРµСЂ

Р”Р°С‚Р°: 2026-10-04. РЎСЂРµР· Р°СѓРґРёС‚Р°: presentation adapters, Android canary, desktop native host, vendor seam Рё РіСЂР°РЅРёС†Р° СѓРїР°РєРѕРІР°РЅРЅРѕРіРѕ Tauri. Р­С‚Рѕ РѕС‚С‡С‘С‚ РѕР± Р°РєС‚СѓР°Р»СЊРЅРѕР№ СЂРµР°Р»РёР·Р°С†РёРё, Р° РЅРµ РІС‹РїРѕР»РЅРµРЅРЅС‹Рµ РёСЃРїСЂР°РІР»РµРЅРёСЏ. РџСЂРѕРґСѓРєС‚РѕРІС‹Р№ РєРѕРґ, API, СЃС…РµРјС‹ РґР°РЅРЅС‹С… Рё СѓС‚РІРµСЂР¶РґС‘РЅРЅС‹Р№ СЃС‚РµРє РЅРµ РёР·РјРµРЅРµРЅС‹.

## РЎС‚Р°С‚СѓСЃС‹ Рё РіСЂР°РЅРёС†С‹ РґРѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІ

- `RUNTIME_CONFIRMED` вЂ” СЌС„С„РµРєС‚ РЅР°Р±Р»СЋРґР°Р»СЃСЏ РЅР° СЃРІРµР¶РµР№ СЃР±РѕСЂРєРµ СЃ СЃРѕС…СЂР°РЅС‘РЅРЅС‹Рј Р°СЂС‚РµС„Р°РєС‚РѕРј.
- `STATIC_CONFIRMED` вЂ” СЂР°Р·СЂС‹РІ РїРѕРґС‚РІРµСЂР¶РґС‘РЅ РѕР±СЂР°Р±РѕС‚С‡РёРєРѕРј Рё РµРіРѕ РІС‹Р·С‹РІР°СЋС‰РёРј РїСѓС‚С‘Рј; С„РёР·РёС‡РµСЃРєРѕРµ РІРѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ РЅРµ Р·Р°СЃС‡РёС‚С‹РІР°РµС‚СЃСЏ.
- `DOCUMENTED_LIMITATION` вЂ” СЏРІРЅРѕ РѕС‚Р»РѕР¶РµРЅРЅР°СЏ РІРѕР·РјРѕР¶РЅРѕСЃС‚СЊ РёР»Рё РѕРіСЂР°РЅРёС‡РµРЅРёРµ; СЌС‚Рѕ РЅРµ РѕР±РµС‰Р°РЅРёРµ РіРѕС‚РѕРІРѕР№ С„СѓРЅРєС†РёРё.
- `RISK_NOT_REPRODUCED` вЂ” СѓС‡Р°СЃС‚РѕРє С‚СЂРµР±СѓРµС‚ С†РµР»РµРІРѕР№ РїСЂРѕРІРµСЂРєРё; Р°РІР°СЂРёСЏ РёР»Рё СѓС‚РµС‡РєР° РЅРµ РґРѕРєР°Р·Р°РЅР°.
- `NOT_RUN` вЂ” РЅРµРѕР±С…РѕРґРёРјРѕРіРѕ РѕРєСЂСѓР¶РµРЅРёСЏ Р»РёР±Рѕ С„РёР·РёС‡РµСЃРєРѕРіРѕ РїСЂРѕРіРѕРЅР° РЅРµС‚.

РЎРІРµР¶Р°СЏ Windows native release-СЃР±РѕСЂРєР° РїСЂРѕС€Р»Р°; Vulkan captures РґРѕСЃС‚СѓРїРЅС‹ РІ Р°СЂС‚РµС„Р°РєС‚Р°С… Р°СѓРґРёС‚Р° (Р»РѕРєР°Р»СЊРЅС‹Р№ РєР°С‚Р°Р»РѕРі build/rust-audit/2026-10-04-1b407fc/). РЎСѓС‰РµСЃС‚РІСѓСЋС‰РёРµ native host feature tests РїСЂРѕС€Р»Рё. Captures РїРѕРґС‚РІРµСЂР¶РґР°СЋС‚ СЂРµРЅРґРµСЂ РїСЂРѕРІРµСЂРµРЅРЅС‹С… РєР°РґСЂРѕРІ, РЅРѕ РЅРµ frame pacing, С„РёР·РёС‡РµСЃРєСѓСЋ РєР»Р°РІРёР°С‚СѓСЂСѓ РёР»Рё Android. РќРµСѓРґР°С‡РЅС‹Р№ scripted tap РЅРµ СЃС‡РёС‚Р°РµС‚СЃСЏ РїРѕРґС‚РІРµСЂР¶РґРµРЅРёРµРј РѕС€РёР±РєРё РґРµР№СЃС‚РІРёСЏ Р±РµР· РїСЂРѕРІРµСЂРєРё РєРѕРѕСЂРґРёРЅР°С‚С‹ Рё РѕР±РѕРёС… hit paths.

Android: `adb` РЅРµ РїРѕРєР°Р·Р°Р» СѓСЃС‚СЂРѕР№СЃС‚РІР°. Gboard, TalkBack, SurfaceView, rotation, insets Рё GPU recovery РЅР° СѓСЃС‚СЂРѕР№СЃС‚РІРµ вЂ” `NOT_RUN`. macOS/Linux runtime вЂ” `NOT_RUN`. РЈРїР°РєРѕРІР°РЅРЅС‹Р№ Tauri runtime вЂ” `NOT_RUN` РІ СЌС‚РѕРј СЃСЂРµР·Рµ; СЃР±РѕСЂРєР° РїР°РєРµС‚Р° Рё kernel smoke РЅРµ СЂР°РІРЅС‹ СЂСѓС‡РЅРѕР№ РїСЂРѕРІРµСЂРєРµ РїРѕР»СЊР·РѕРІР°С‚РµР»СЊСЃРєРёС… СЃС†РµРЅР°СЂРёРµРІ. РћР±С‰РёРµ РёС‚РѕРіРѕРІС‹Рµ РєРѕРјР°РЅРґС‹ Рё РёС… СЂРµР·СѓР»СЊС‚Р°С‚С‹ РЅР°С…РѕРґСЏС‚СЃСЏ РІ [РїСЂРѕС‚РѕРєРѕР»Рµ РїСЂРѕРІРµСЂРѕРє](VERIFICATION.md).

### Р Р°Р·РґРµР»РµРЅРёРµ СЂРµР¶РёРјРѕРІ

| Р РµР¶РёРј                   | РџСЂРѕРІРѕРґ Рё РѕР±РѕР»РѕС‡РєР°                                                     | Р§С‚Рѕ РѕРЅ РґРѕРєР°Р·С‹РІР°РµС‚                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `neocompositor-desktop`      | `FakeWire`, winit, Dioxus/Blitz/Vello                                                | РќР°С‚РёРІРЅС‹Р№ presentation РЅР° С‚РµСЃС‚РѕРІС‹С… РґР°РЅРЅС‹С…; СЃРѕС…СЂР°РЅРЅРѕСЃС‚СЊ РїРѕР»СЊР·РѕРІР°С‚РµР»СЊСЃРєРѕР№ Р±РёР±Р»РёРѕС‚РµРєРё РЅРµ РїСЂРѕРІРµСЂСЏРµС‚ |
| `neocompositor-kernel`       | `KernelProductWire`, С‚РѕС‚ Р¶Рµ desktop host                                        | РќР°СЃС‚РѕСЏС‰РёРµ wire operations Рё SQLite, РїР»СЋСЃ desktop presentation                                                                                            |
| Android canary               | `JniProductWire`, Kotlin host, РѕС‚РґРµР»СЊРЅС‹Р№ `GpuHost`                          | РўСЂРµР±СѓРµС‚ С„РёР·РёС‡РµСЃРєРѕРіРѕ runtime; desktop captures РЅРµ Р·Р°РјРµРЅСЏСЋС‚ СЌС‚Сѓ РїСЂРѕРІРµСЂРєСѓ                                                          |
| РЈРїР°РєРѕРІР°РЅРЅС‹Р№ Tauri | React/WebView; Kernel Preview РёР»Рё legacy sidecar РїРѕ РјР°С‚СЂРёС†Рµ СЂРµР¶РёРјР° | РЎР°РјРѕСЃС‚РѕСЏС‚РµР»СЊРЅС‹Р№ РїСЂРѕРґСѓРєС‚РѕРІС‹Р№ РїСѓС‚СЊ; СЌС‚Рѕ РЅРµ Dioxus/Blitz/Vello                                                                         |

РСЃС‚РѕС‡РЅРёРєРё: `presentation-chat/src/bin/neocompositor-desktop.rs` Р·Р°РґР°С‘С‚ `wire: None`; `presentation-kernel-wire/src/bin/neocompositor-kernel.rs` РёРЅР¶РµРєС‚РёСЂСѓРµС‚ РЅР°СЃС‚РѕСЏС‰РёР№ kernel; `apps/desktop/src-tauri/tauri.conf.json` РёСЃРїРѕР»СЊР·СѓРµС‚ `../../web/dist`; `apps/desktop/src-tauri/src/lib.rs` СЃРѕР·РґР°С‘С‚ `WebviewWindowBuilder`. Release РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ РёСЃРїРѕР»СЊР·СѓРµС‚ sidecar, nightly/debug вЂ” Kernel; СЏРІРЅС‹Рµ overrides СЂР°Р·СЂРµС€Р°СЋС‚СЃСЏ СЃРѕРіР»Р°СЃРЅРѕ ADR-0038. РЈСЃРїРµС€РЅС‹Рµ kernel/JNI transport tests РЅРµ РѕР·РЅР°С‡Р°СЋС‚, С‡С‚Рѕ Android compositor, IME РёР»Рё TalkBack СЂР°Р±РѕС‚РѕСЃРїРѕСЃРѕР±РЅС‹.

## РЎРёСЃС‚РµРјРЅС‹Рµ РїСЂРёС‡РёРЅС‹ РЅР°РєРѕРїР»РµРЅРёСЏ РѕР±С…РѕРґРЅС‹С… СЂРµС€РµРЅРёР№

РџСЂРѕР±Р»РµРјР° РЅРµ СЃРІРѕРґРёС‚СЃСЏ Рє clipping. Р’ С‚РµРєСѓС‰РµР№ СЂРµР°Р»РёР·Р°С†РёРё РЅРµСЃРєРѕР»СЊРєРѕ РїРѕРґСЃРёСЃС‚РµРј РёРјРµСЋС‚ РѕР±С‰РёР№ С„РѕСЂРјР°С‚ РґР°РЅРЅС‹С…, РЅРѕ СЂР°Р·Р»РёС‡Р°СЋС‚СЃСЏ РІР»Р°РґРµР»СЊС†РµРј Р¶РёР·РЅРµРЅРЅРѕРіРѕ С†РёРєР»Р° Рё СЃРїРѕСЃРѕР±РѕРј РёСЃРїРѕР»РЅРµРЅРёСЏ. Р›РѕРєР°Р»СЊРЅС‹Рµ РІРёР·СѓР°Р»СЊРЅС‹Рµ РёСЃРїСЂР°РІР»РµРЅРёСЏ РЅРµ Р·Р°РєСЂС‹РІР°СЋС‚ СЌС‚Рё РіСЂР°РЅРёС†С‹.

1. **РћР±С‰РёР№ producer РЅРµ РѕР·РЅР°С‡Р°РµС‚ РѕР±С‰РёР№ presentation host.** Desktop СЃРѕС…СЂР°РЅСЏРµС‚ VDOM, РґРµР»Р°РµС‚ `open_or_refresh`, `paint_split` Рё overscan; Android cold-opens РґРѕРєСѓРјРµРЅС‚ Рё СЂР°СЃС‚РµСЂРёР·СѓРµС‚ РѕРґРЅСѓ РїРѕР»РЅСѓСЋ СЃС†РµРЅСѓ. РЈ РЅРёС… СЂР°Р·РЅС‹Рµ input, clipboard/export Рё stream loops. РЈС‚РІРµСЂР¶РґРµРЅРёРµ Рѕ byte-identical РїРѕРІРµРґРµРЅРёРё СЃРєСЂС‹РІР°РµС‚ РЅРµРѕР±С…РѕРґРёРјРѕСЃС‚СЊ РѕС‚РґРµР»СЊРЅРѕР№ РїСЂРѕРІРµСЂРєРё РїР»Р°С‚С„РѕСЂРјС‹. РЎРј. PL-L02.
2. **РќР°СЂРёСЃРѕРІР°РЅРЅРѕРµ РїРѕР»Рµ РЅРµ СЏРІР»СЏРµС‚СЃСЏ СЂРµРґР°РєС‚РѕСЂРѕРј.** Desktop РІСЂСѓС‡РЅСѓСЋ РґРѕРїРёСЃС‹РІР°РµС‚ СЃС‚СЂРѕРєСѓ, Android СЃРѕС…СЂР°РЅРёР» РЅРµРІРёРґРёРјС‹Р№ `EditText` Р±РµР· СЃРІСЏР·Рё СЃ РІРёРґРёРјС‹Рј РїРѕР»РµРј. РќРµС‚ РѕР±С‰РµРіРѕ СЃРѕР±С‹С‚РёСЏ field focus, caret/selection/composition Рё РїРѕРґС‚РІРµСЂР¶РґРµРЅРёСЏ РµРіРѕ РёСЃРїРѕР»РЅРµРЅРёСЏ РїР»Р°С‚С„РѕСЂРјРѕР№. Р”РѕР±Р°РІР»РµРЅРёРµ РµС‰С‘ РѕРґРЅРѕРіРѕ setter РЅР° РєРѕРЅРєСЂРµС‚РЅС‹Р№ СЌРєСЂР°РЅ СѓРІРµР»РёС‡РёРІР°РµС‚ СЌС‚РѕС‚ СЂР°Р·СЂС‹РІ. РЎРј. PL-01, PL-03, PL-06.
3. **РЈ СЃС‚СЂРёРјР° РЅРµСЃРєРѕР»СЊРєРѕ РЅРµР·Р°РІРёСЃРёРјС‹С… РґСЂР°Р№РІРµСЂРѕРІ.** Rust Send РІС‹РїРѕР»РЅСЏРµС‚СЃСЏ РІРЅСѓС‚СЂРё compositor callback, Kotlin IME Send Р·Р°РїСѓСЃРєР°РµС‚ bounded polling РѕС‚РґРµР»СЊРЅРѕ, Р° СЃС‚Р°СЂС‚ JNI РјРѕР¶РµС‚ Р¶РґР°С‚СЊ РїРµСЂРІРѕРµ СЃРѕР±С‹С‚РёРµ СЃРёРЅС…СЂРѕРЅРЅРѕ. РћРґРёРЅ РїСѓС‚СЊ СЃРѕР·РґР°С‘С‚ run Р±РµР· polling, РґСЂСѓРіРѕР№ Р·Р°РєР°РЅС‡РёРІР°РµС‚ polling РїРѕ СЃС‡С‘С‚С‡РёРєСѓ. РЎРј. PL-04, PL-05.
4. **Р—Р°РїРёСЃСЊ РІРѕР·РјРѕР¶РЅРѕСЃС‚Рё СЂР°СЃС…РѕРґРёС‚СЃСЏ СЃ РµС‘ РёСЃРїРѕР»РЅРµРЅРёРµРј.** Glass markers Рё pass graph СЃСѓС‰РµСЃС‚РІСѓСЋС‚, РЅРѕ product VelloSink РёРіРЅРѕСЂРёСЂСѓРµС‚ filters/backdrop filters. Р§РёСЃР»Рѕ markers РЅРµ РїРѕРґС‚РІРµСЂР¶РґР°РµС‚ РІРёР·СѓР°Р»СЊРЅСѓСЋ РІРѕР·РјРѕР¶РЅРѕСЃС‚СЊ. РЎРј. PL-L01.
5. **РќРµРєРѕС‚РѕСЂС‹Рµ fallback РјРµРЅСЏСЋС‚ РёРЅРІР°СЂРёР°РЅС‚С‹.** Р’РѕР·РІСЂР°С‚ Рє image overlay СЃРїР°СЃР°РµС‚ raster РЅР° РїСЂРѕР±Р»РµРјРЅРѕРј РґСЂР°Р№РІРµСЂРµ, РЅРѕ С‚РµСЂСЏРµС‚ РѕР±С‰РёР№ paint order Рё modal/clip semantics. Р­С‚Рѕ РґРѕРїСѓСЃС‚РёРјС‹Р№ РґРѕРєСѓРјРµРЅС‚РёСЂРѕРІР°РЅРЅС‹Р№ degraded mode, РµСЃР»Рё РёРЅС‚РµСЂС„РµР№СЃ Рё РґРёР°РіРЅРѕСЃС‚РёРєР° СЃРѕРѕР±С‰Р°СЋС‚ РѕРіСЂР°РЅРёС‡РµРЅРёРµ Рё РѕРЅ РїСЂРѕРІРµСЂСЏРµС‚СЃСЏ РѕС‚РґРµР»СЊРЅРѕ. Р•РіРѕ РЅРµР»СЊР·СЏ СЃС‡РёС‚Р°С‚СЊ РїРѕР»РЅРѕР№ parity. РЎРј. PL-L04.

Р РµРєРѕРјРµРЅРґСѓРµРјС‹Р№ РїРѕСЂСЏРґРѕРє РёСЃРїСЂР°РІР»РµРЅРёСЏ: РѕРїСЂРµРґРµР»РёС‚СЊ РѕР±С‰РёРµ input/semantics Рё stream lifecycle РёРЅРІР°СЂРёР°РЅС‚С‹; СЃРІСЏР·Р°С‚СЊ РїР»Р°С‚С„РѕСЂРјРµРЅРЅС‹Рµ capabilities СЃ РЅРёРјРё; РѕР±РµСЃРїРµС‡РёС‚СЊ РѕРґРёРЅР°РєРѕРІС‹Рµ contract tests Р°РґР°РїС‚РµСЂРѕРІ; Р·Р°С‚РµРј РёСЃРїСЂР°РІР»СЏС‚СЊ РіРµРѕРјРµС‚СЂРёСЋ Рё РѕРїС‚РёРјРёР·РёСЂРѕРІР°С‚СЊ РєР°РґСЂС‹. Р­С‚Рѕ РЅРµ С‚СЂРµР±СѓРµС‚ СЃРјРµРЅС‹ СѓС‚РІРµСЂР¶РґС‘РЅРЅРѕРіРѕ СЃС‚РµРєР°. РќРµ РєР°Р¶РґС‹Р№ fallback РІСЂРµРґРµРЅ: sidecar release default, СЏРІРЅС‹Р№ canary kill-switch Рё last-known-good recovery СЏРІР»СЏСЋС‚СЃСЏ РїСЂРёРЅСЏС‚С‹РјРё РіСЂР°РЅРёС†Р°РјРё, РїРѕРєР° РѕРЅРё С‡РµСЃС‚РЅРѕ РѕР±РѕР·РЅР°С‡РµРЅС‹.

## РљР°С‚Р°Р»РѕРі РґРµС„РµРєС‚РѕРІ

### PL-01 вЂ” P1 вЂ” РќРµРїРѕР»РЅР°СЏ РјРѕРґРµР»СЊ РІРІРѕРґР° desktop

- **РЎС‚Р°С‚СѓСЃ / С…РѕСЃС‚С‹:** `STATIC_CONFIRMED`; native desktop СЃ FakeWire Рё Kernel. Р¤РёР·РёС‡РµСЃРєР°СЏ OS-РєР»Р°РІРёР°С‚СѓСЂР° Рё IME вЂ” `NOT_RUN`.
- **РЎРёРјРїС‚РѕРј:** append-only РІРІРѕРґ; Enter, Tab, Escape, arrows, Home/End, Delete, selection, clipboard shortcuts Рё IME composition РЅРµ РѕР±СЃР»СѓР¶РёРІР°СЋС‚СЃСЏ.
- **РћР¶РёРґР°РµС‚СЃСЏ:** СЂРµРґР°РєС‚РёСЂРѕРІР°РЅРёРµ РІ РїРѕР·РёС†РёРё caret, РІС‹РґРµР»РµРЅРёРµ, РїРµСЂРµРЅРѕСЃ СЃС‚СЂРѕРєРё Рё РєР»Р°РІРёР°С‚СѓСЂРЅР°СЏ РЅР°РІРёРіР°С†РёСЏ РїРѕ РїРѕР»СЏРј/РґРµР№СЃС‚РІРёСЏРј.
- **РљРѕРѕСЂРґРёРЅР°С‚С‹ / РґРѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІРѕ:** `crates/presentation-chat/src/desktop_host/frame.rs:612вЂ“624` РѕР±СЂР°Р±Р°С‚С‹РІР°РµС‚ С‚РѕР»СЊРєРѕ `Key::Character` Рё Backspace, РѕСЃС‚Р°Р»СЊРЅС‹Рµ keys РёРіРЅРѕСЂРёСЂСѓРµС‚. `desktop_host/text.rs:20вЂ“29` РґРµР»Р°РµС‚ `format!("{current}{ch}")`; `text.rs:294` СѓРґР°Р»СЏРµС‚ РїРѕСЃР»РµРґРЅРёР№ scalar. РќРµС‚ РјР°СЂС€СЂСѓС‚РёР·Р°С†РёРё `WindowEvent::Ime` Рё modifiers РІ editor.
- **Р’РѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ:** focus composer, РІРІРµСЃС‚Рё `abc`, Left, `X`; РїСѓС‚СЊ РѕР±СЂР°Р±РѕС‚С‡РёРєР° РґР°С‘С‚ `abcX`. РџСЂРѕРІРµСЂРёС‚СЊ Enter Рё Ctrl+V РѕС‚РґРµР»СЊРЅРѕ: modifiers РЅРµ СѓС‡РёС‚С‹РІР°СЋС‚СЃСЏ, РІСЃС‚Р°РІРєР° clipboard РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚. CLI `--type` РїСЂРѕРІРµСЂСЏРµС‚ setter, Р° РЅРµ OS keyboard integration.
- **РџСЂРёС‡РёРЅР°:** СЂСѓС‡РЅС‹Рµ draft setters РёСЃРїРѕР»СЊР·СѓСЋС‚СЃСЏ РІРјРµСЃС‚Рѕ editor input model.
- **РСЃРїСЂР°РІР»РµРЅРёРµ / Р·Р°РІРёСЃРёРјРѕСЃС‚Рё:** РѕР±С‰РёР№ field input bridge СЃ stable IDs, caret/selection, grapheme deletion Рё composition; clipboard вЂ” capability С…РѕСЃС‚Р°. РЎРѕРіР»Р°СЃРѕРІР°С‚СЊ СЃ PL-03/06 РґРѕ СЂР°СЃС€РёСЂРµРЅРёСЏ СЃРїРёСЃРєР° РѕС‚РґРµР»СЊРЅС‹С… setters.
- **РџСЂРёС‘РјРєР°:** СЂРµР°Р»СЊРЅС‹Рµ middle insertion/selection replacement, Ctrl+A/C/X/V, multiline, emoji deletion, Tab/Shift+Tab/Escape Рё IME commit/preedit; СЂРµР·СѓР»СЊС‚Р°С‚ СЃРѕРІРїР°РґР°РµС‚ РЅР° FakeWire/Kernel Рё СЃРѕС…СЂР°РЅСЏРµС‚СЃСЏ РєРѕСЂСЂРµРєС‚РЅРѕ.

### PL-02 вЂ” P1 вЂ” РЎРѕРґРµСЂР¶РёРјРѕРµ С‡РµСЂРЅРѕРІРёРєРѕРІ РїРѕРїР°РґР°РµС‚ РІ stderr

- **РЎС‚Р°С‚СѓСЃ / С…РѕСЃС‚С‹:** `RUNTIME_CONFIRMED`; native desktop. Р РµР°Р»СЊРЅС‹Р№ РІРІРѕРґ РІС‹РїРѕР»РЅРµРЅ CLI injection, С„РёР·РёС‡РµСЃРєР°СЏ РєР»Р°РІРёР°С‚СѓСЂР° РЅРµ РїСЂРѕРІРµСЂРµРЅР°.
- **РЎРёРјРїС‚РѕРј:** РїРѕР»РЅС‹Р№ composer Рё РґСЂСѓРіРёРµ РїРѕР»СЏ Р¶СѓСЂРЅР°Р»РёСЂСѓСЋС‚СЃСЏ РЅР° РєР°Р¶РґС‹Р№ СЃРёРјРІРѕР» Р±РµР· opt-in.
- **РћР¶РёРґР°РµС‚СЃСЏ:** РґРёР°РіРЅРѕСЃС‚РёС‡РµСЃРєРёРµ РјРµС‚Р°РґР°РЅРЅС‹Рµ Р±РµР· РїРѕР»СЊР·РѕРІР°С‚РµР»СЊСЃРєРѕРіРѕ С‚РµРєСЃС‚Р°.
- **РљРѕРѕСЂРґРёРЅР°С‚С‹:** `desktop_host/text.rs:29`, `:35`, `:41`, `:95`, `:161`, `:179`, `:219` Рё СЃРѕСЃРµРґРЅРёРµ РІРµС‚РєРё.
- **Р”РѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІРѕ:** native-live-send.native.log (Р»РѕРєР°Р»СЊРЅС‹Р№ РєР°С‚Р°Р»РѕРі build/rust-audit/2026-10-04-1b407fc/) СЃРѕРґРµСЂР¶РёС‚ РІРѕР·СЂР°СЃС‚Р°СЋС‰РёРµ РїСЂРµС„РёРєСЃС‹ Рё `composer="AUDIT_INPUT_MARKER"` РЅР° СЃС‚СЂРѕРєРµ 37; Р»РѕРіРёСЂРѕРІР°РЅРёРµ РЅРµ С‚СЂРµР±СѓРµС‚ РѕС‚РґРµР»СЊРЅРѕРіРѕ opt-in.
- **Р’РѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ:** СЃРІРµР¶РёР№ native host, redirected stderr, focus composer, `--type AUDIT_INPUT_MARKER`; РёСЃРєР°С‚СЊ marker Рё РїСЂРµС„РёРєСЃС‹ РІ Р»РѕРіРµ. РђРЅР°Р»РѕРіРёС‡РЅС‹Рµ РІРµС‚РєРё СЃСѓС‰РµСЃС‚РІСѓСЋС‚ РґР»СЏ search/edit/character drafts.
- **РџСЂРёС‡РёРЅР°:** РѕС‚Р»Р°РґРѕС‡РЅС‹Рµ payload logs РІСЃС‚СЂРѕРµРЅС‹ РІ РѕР±С‹С‡РЅС‹Р№ input path. РџРѕРІС‚РѕСЂРµРЅРёРµ РїСЂРµС„РёРєСЃРѕРІ РґРѕРїРѕР»РЅРёС‚РµР»СЊРЅРѕ РґР°С‘С‚ РєРІР°РґСЂР°С‚РёС‡РЅС‹Р№ РѕР±СЉС‘Рј Р»РѕРіРѕРІ РґР»РёРЅРЅРѕР№ СЃС‚СЂРѕРєРё.
- **РСЃРїСЂР°РІР»РµРЅРёРµ / Р·Р°РІРёСЃРёРјРѕСЃС‚Рё:** СѓР±СЂР°С‚СЊ payload logs; РѕСЃС‚Р°РІР»СЏС‚СЊ field ID, РґР»РёРЅСѓ Рё РєРѕРґ РѕРїРµСЂР°С†РёРё. РќРµР·Р°РІРёСЃРёРјРѕРµ РёСЃРїСЂР°РІР»РµРЅРёРµ РґРѕ СЂР°СЃС€РёСЂРµРЅРёСЏ native input.
- **РџСЂРёС‘РјРєР°:** СѓРЅРёРєР°Р»СЊРЅС‹Рµ РјР°СЂРєРµСЂС‹ РёР· composer/edit/search РѕС‚СЃСѓС‚СЃС‚РІСѓСЋС‚ РІ stderr Рё diagnostic export; РѕС‚РґРµР»СЊРЅС‹Рµ typed СЃРёРјРІРѕР»С‹ С‚Р°РєР¶Рµ РЅРµ СЃРѕР±РёСЂР°СЋС‚СЃСЏ РІ С‚РµРєСЃС‚.

### PL-03 вЂ” P1 вЂ” Android IME РЅРµ СЃРІСЏР·Р°РЅ СЃ РІРёРґРёРјС‹РјРё РїРѕР»СЏРјРё

- **РЎС‚Р°С‚СѓСЃ / С…РѕСЃС‚С‹:** `STATIC_CONFIRMED`; Android canary. РџРѕРєР°Р· Gboard Рё composition вЂ” `NOT_RUN`.
- **РЎРёРјРїС‚РѕРј:** visible compositor composer/search/edit РїРѕР»СЏ РЅРµ РёРјРµСЋС‚ РїР»Р°С‚С„РѕСЂРјРµРЅРЅРѕРіРѕ focus/InputConnection handoff.
- **РћР¶РёРґР°РµС‚СЃСЏ:** tap РїРѕР»СЏ РІС‹Р±РёСЂР°РµС‚ РµРіРѕ stable ID, РѕС‚РєСЂС‹РІР°РµС‚ IME Рё РѕС‚РѕР±СЂР°Р¶Р°РµС‚ Р°РєС‚СѓР°Р»СЊРЅС‹Рµ caret/selection/composition.
- **РљРѕРѕСЂРґРёРЅР°С‚С‹ / РґРѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІРѕ:** `PresentationChatActivity.kt:143вЂ“178` СЃРѕР·РґР°С‘С‚ РµРґРёРЅСЃС‚РІРµРЅРЅС‹Р№ bridge СЃ `alpha=0f`, `visibility=View.INVISIBLE`, СЂР°Р·РјРµСЂРѕРј 1Г—1. Р’ Activity РЅРµС‚ `requestFocus()`. `:202вЂ“204` РѕСЃС‚Р°РІР»СЏРµС‚ С‚РѕР»СЊРєРѕ СЌС‚РѕС‚ bridge. `android_surface.rs:1192вЂ“1223` Р·Р°С…РІР°С‚С‹РІР°РµС‚ actions РёР»Рё scroll; РѕР±СЂР°С‚РЅРѕР№ РєРѕРјР°РЅРґС‹ Kotlin focus РЅРµС‚. `syncChatOverlay` РЅРµ РїСЂРёРєСЂРµРїР»СЏРµС‚ РїРѕР»СЏ.
- **Р’РѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ:** С„РёР·РёС‡РµСЃРєРёР№ canary, tap composer/search/message edit/character editor; РЅР°Р±Р»СЋРґР°С‚СЊ focus, IME, caret Рё СЃРѕРѕС‚РІРµС‚СЃС‚РІСѓСЋС‰РёР№ draft snapshot. Р”Рѕ СѓСЃС‚СЂРѕР№СЃС‚РІР° РІС‹РІРѕРґ РѕРіСЂР°РЅРёС‡РµРЅ РѕС‚СЃСѓС‚СЃС‚РІРёРµРј wiring РІ РєРѕРґРµ.
- **РџСЂРёС‡РёРЅР°:** СѓРґР°Р»РµРЅРёРµ native overlay Р±РµР· Р·Р°РјРµРЅС‹ РЅР° field-aware platform bridge.
- **РСЃРїСЂР°РІР»РµРЅРёРµ / Р·Р°РІРёСЃРёРјРѕСЃС‚Рё:** РѕР±С‰РёР№ input model PL-01; focusable Android bridge, СѓРїСЂР°РІР»СЏРµРјС‹Р№ frame field ID, Р° РЅРµ С„РёРєС‚РёРІРЅС‹Рј composer РґР»СЏ РІСЃРµС… РїРѕР»РµР№.
- **РџСЂРёС‘РјРєР°:** Gboard commit, composition, selection Рё deletion РёР·РјРµРЅСЏСЋС‚ РІС‹Р±СЂР°РЅРЅРѕРµ РїРѕР»Рµ; IME/caret РѕС‚РЅРѕСЃСЏС‚СЃСЏ Рє РѕРґРЅРѕРјСѓ snapshot; СЃРјРµРЅР° panel/chat РЅРµ Р·Р°РїРёСЃС‹РІР°РµС‚ РІРІРѕРґ РІ РїСЂРµР¶РЅРµРµ РїРѕР»Рµ.

### PL-04 вЂ” P1 вЂ” Р Р°Р·РЅС‹Рµ Send paths РЅРµ РёРјРµСЋС‚ РѕР±С‰РµРіРѕ stream lifecycle

- **РЎС‚Р°С‚СѓСЃ / С…РѕСЃС‚С‹:** `STATIC_CONFIRMED`; Android canary. РЈСЃС‚СЂРѕР№СЃС‚РІРѕ вЂ” `NOT_RUN`.
- **РЎРёРјРїС‚РѕРј:** visible Rust Send СЃС‚Р°СЂС‚СѓРµС‚ run Р±РµР· stream polling; Kotlin poll burst Р·Р°РєР°РЅС‡РёРІР°РµС‚СЃСЏ РїРѕ СЃС‡С‘С‚С‡РёРєСѓ РґР°Р¶Рµ РїСЂРё РїСЂРѕРґРѕР»Р¶Р°СЋС‰РµРјСЃСЏ run.
- **РћР¶РёРґР°РµС‚СЃСЏ:** РІСЃРµ Send entrypoints РїРѕРґРїРёСЃР°РЅС‹ РґРѕ terminal/cancel/unsubscribe; РѕРєРѕРЅС‡Р°РЅРёРµ burst РЅРµ РѕР·РЅР°С‡Р°РµС‚ РѕРєРѕРЅС‡Р°РЅРёРµ run.
- **РљРѕРѕСЂРґРёРЅР°С‚С‹ / РґРѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІРѕ:** `android_jni.rs:607вЂ“610` РІС‹Р·С‹РІР°РµС‚ `session.send(None)` Р±РµР· poll/pump. `PresentationChatActivity.kt:603вЂ“608`, `:628вЂ“636` С‚РѕР»СЊРєРѕ РІС‹Р·С‹РІР°СЋС‚ `presentFrame`. РћС‚РґРµР»СЊРЅС‹Р№ `pollStream` (`android_jni.rs:448вЂ“462`) РёСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ Kotlin `pollStreamingBounded`; `Activity:703`, `:711` РѕРіСЂР°РЅРёС‡РёРІР°СЋС‚ РµРіРѕ 40 polls. Completion `:754вЂ“770` РѕР±СЉСЏРІР»СЏРµС‚ stream_end, РґР°Р¶Рµ РµСЃР»Рё snapshot РµС‰С‘ streaming.
- **Р’РѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ:** mock provider СЃ Р·Р°РґРµСЂР¶РєР°РјРё token events; Send РёР· РІРёРґРёРјРѕРіРѕ Rust UI; СЃСЂР°РІРЅРёС‚СЊ durable event log Рё visible snapshot. РћС‚РґРµР»СЊРЅРѕ С‡РµСЂРµР· IME Send РїРѕР»СѓС‡РёС‚СЊ Р±РѕР»СЊС€Рµ 40 timeout/event polls Рё РїСЂРѕРІРµСЂРёС‚СЊ РѕС‚СЃСѓС‚СЃС‚РІРёРµ terminal РїСЂРё РѕР±СЉСЏРІР»РµРЅРЅРѕРј РѕРєРѕРЅС‡Р°РЅРёРё.
- **РџСЂРёС‡РёРЅР°:** UI action dispatch Рё Kotlin polling РІР»Р°РґРµСЋС‚ СЂР°Р·РЅС‹РјРё С‡Р°СЃС‚СЏРјРё lifecycle Р±РµР· РѕР±С‰РµРіРѕ РІР»Р°РґРµР»СЊС†Р°.
- **РСЃРїСЂР°РІР»РµРЅРёРµ / Р·Р°РІРёСЃРёРјРѕСЃС‚Рё:** РµРґРёРЅС‹Р№ subscription driver; bounded work Р·Р° burst СЃ re-arm РґРѕ terminal, lifecycle token Рё explicit unsubscribe. РЎРІСЏР·Р°РЅРѕ СЃ PL-05 Рё PL-R02.
- **РџСЂРёС‘РјРєР°:** visible Send Рё IME Send РѕРґРёРЅР°РєРѕРІРѕ РґРѕСЃС‚Р°РІР»СЏСЋС‚ СЃРѕР±С‹С‚РёСЏ; РјРµРґР»РµРЅРЅР°СЏ РіРµРЅРµСЂР°С†РёСЏ РґРѕС…РѕРґРёС‚ РґРѕ terminal Р±РµР· refresh; cancel РЅРµРјРµРґР»РµРЅРµРЅ; route change РѕС‚РїРёСЃС‹РІР°РµС‚СЃСЏ Р±РµР· РѕС‚РјРµРЅС‹ durable run.

### PL-05 вЂ” P1 вЂ” Stream start Р±Р»РѕРєРёСЂСѓРµС‚ Android compositor

- **РЎС‚Р°С‚СѓСЃ / С…РѕСЃС‚С‹:** `STATIC_CONFIRMED`; Android canary. Р¤РёР·РёС‡РµСЃРєРѕРµ РёР·РјРµСЂРµРЅРёРµ stalls вЂ” `NOT_RUN`.
- **РЎРёРјРїС‚РѕРј:** Send/Regenerate РЅР° compositor thread РјРѕРіСѓС‚ Р¶РґР°С‚СЊ РїРµСЂРІРѕРµ СЃРѕР±С‹С‚РёРµ РґРѕ 1,6 СЃРµРєСѓРЅРґС‹ РїР»СЋСЃ dispatch.
- **РћР¶РёРґР°РµС‚СЃСЏ:** compositor РЅРµ Р¶РґС‘С‚ provider token Рё РїСЂРѕРґРѕР»Р¶Р°РµС‚ present/input/cancel.
- **РљРѕРѕСЂРґРёРЅР°С‚С‹ / РґРѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІРѕ:** `JniProductWire::start_stream`, `android_jni.rs:190вЂ“216`, РІС‹РїРѕР»РЅСЏРµС‚ РґРѕ `32 Г— wait_native(..., 50)`. Visible Send/Regenerate РІС‹Р·С‹РІР°СЋС‚СЃСЏ РІРЅСѓС‚СЂРё `presentFrame:592вЂ“641`, Р·Р°РїСѓС‰РµРЅРЅРѕРіРѕ СЃ compositor handler (`Activity:603`).
- **Р’РѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ:** mock transport Р·Р°РґРµСЂР¶РёРІР°РµС‚ РїРµСЂРІРѕРµ СЃРѕР±С‹С‚РёРµ РЅР° 2 СЃРµРєСѓРЅРґС‹; tap Send; Р·Р°РїРёСЃР°С‚СЊ present timestamps Рё cancellation latency. 1,6 СЃРµРєСѓРЅРґС‹ вЂ” СЃС‚Р°С‚РёС‡РµСЃРєРёР№ РїСЂРµРґРµР» wait loop, РЅРµ РёР·РјРµСЂРµРЅРЅС‹Р№ frame result.
- **РџСЂРёС‡РёРЅР°:** РїРѕРёСЃРє stream key/РїРµСЂРІРѕРіРѕ event РІС‹РїРѕР»РЅСЏРµС‚СЃСЏ СЃРёРЅС…СЂРѕРЅРЅРѕ РІ rendering callback.
- **РСЃРїСЂР°РІР»РµРЅРёРµ / Р·Р°РІРёСЃРёРјРѕСЃС‚Рё:** Р±С‹СЃС‚СЂС‹Р№ stream-start handshake, РѕР¶РёРґР°РЅРёРµ СЃРѕР±С‹С‚РёР№ РІРЅРµ compositor, bounded delivery queue; РµРґРёРЅС‹Р№ lifecycle PL-04.
- **РџСЂРёС‘РјРєР°:** Р·Р°РґРµСЂР¶РєР° РїРµСЂРІРѕРіРѕ token РЅРµ РѕСЃС‚Р°РЅР°РІР»РёРІР°РµС‚ scroll/present/cancel; СЃС‚Р°СЂС‚ РІРѕР·РІСЂР°С‰Р°РµС‚ handle РЅРµР·Р°РІРёСЃРёРјРѕ РѕС‚ РіРѕС‚РѕРІРЅРѕСЃС‚Рё token; slow-provider trace СѓРєР»Р°РґС‹РІР°РµС‚СЃСЏ РІ СЃРѕРіР»Р°СЃРѕРІР°РЅРЅС‹Р№ frame budget.

### PL-06 вЂ” P1 вЂ” Android accessibility РЅРµ РїРѕР»СѓС‡Р°РµС‚ РґРµСЂРµРІРѕ UI

- **РЎС‚Р°С‚СѓСЃ / С…РѕСЃС‚С‹:** `STATIC_CONFIRMED`; Android canary. Р РµР°Р»СЊРЅС‹Р№ TalkBack вЂ” `NOT_RUN`.
- **РЎРёРјРїС‚РѕРј:** СЃРѕРѕР±С‰РµРЅРёСЏ, РєРЅРѕРїРєРё Рё РїРѕР»СЏ РЅР°СЂРёСЃРѕРІР°РЅС‹, РЅРѕ РѕС‚СЃСѓС‚СЃС‚РІСѓСЋС‚ virtual accessibility descendants. Scroll forward РѕС‚РІРµС‡Р°РµС‚ success Р±РµР· РґРІРёР¶РµРЅРёСЏ.
- **РћР¶РёРґР°РµС‚СЃСЏ:** localized semantic tree СЃ bounds/actions/stable IDs Рё СЃРѕС…СЂР°РЅРµРЅРёРµРј С„РѕРєСѓСЃР° РїСЂРё virtualized updates.
- **РљРѕРѕСЂРґРёРЅР°С‚С‹ / РґРѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІРѕ:** `Activity:202вЂ“204`, `:891вЂ“931`: minimal SurfaceView delegate, Р±РµР· `AccessibilityNodeProvider`/`ExploreByTouchHelper` РёР»Рё export Rust semantics. `:917вЂ“924` РІС‹Р·С‹РІР°РµС‚ prepend С‚РѕР»СЊРєРѕ backward; forward РїСЂРѕСЃС‚Рѕ РІРѕР·РІСЂР°С‰Р°РµС‚ true.
- **Р’РѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ:** TalkBack РёСЃСЃР»РµРґСѓРµС‚ СЃРѕРѕР±С‰РµРЅРёСЏ, action toolbar Рё РїР°РЅРµР»СЊ; Р·Р°С‚РµРј РІС‹РїРѕР»РЅСЏРµС‚ scroll forward/backward. РџСЂРѕРІРµСЂРёС‚СЊ node names/bounds/actions, offset Рё focus retention.
- **РџСЂРёС‡РёРЅР°:** РІРЅСѓС‚СЂРµРЅРЅРёР№ semantic snapshot РЅРµ РїРѕРґРєР»СЋС‡С‘РЅ Рє Android accessibility API. Р›РѕРіРёСЂРѕРІР°РЅРёРµ СЃРѕР±С‹С‚РёР№ РЅРµ СЃРѕР·РґР°С‘С‚ semantic tree.
- **РСЃРїСЂР°РІР»РµРЅРёРµ / Р·Р°РІРёСЃРёРјРѕСЃС‚Рё:** platform semantics adapter Рё РѕР±С‰РёР№ focus contract PL-01/03; accessibility scroll РґРѕР»Р¶РµРЅ РјРµРЅСЏС‚СЊ viewport offset.
- **РџСЂРёС‘РјРєР°:** TalkBack С‡РёС‚Р°РµС‚ СЃРѕРѕР±С‰РµРЅРёСЏ, РЅР°С…РѕРґРёС‚ РєРЅРѕРїРєРё/РїРѕР»СЏ, РІС‹РїРѕР»РЅСЏРµС‚ РґРµР№СЃС‚РІРёСЏ; focus СЃС‚Р°Р±РёР»РµРЅ РїРѕСЃР»Рµ prepend/rotation; РѕР±Рµ scroll actions РјРµРЅСЏСЋС‚ РїРѕР»РѕР¶РµРЅРёРµ.

### PL-07 вЂ” P2 вЂ” Android Copy Рё Export РЅРµ РёРјРµСЋС‚ platform capability

- **РЎС‚Р°С‚СѓСЃ / С…РѕСЃС‚С‹:** `STATIC_CONFIRMED`; Android canary. Clipboard/document/share runtime вЂ” `NOT_RUN`.
- **РЎРёРјРїС‚РѕРј:** Copy вЂ” СЏРІРЅС‹Р№ no-op; Export РјРѕР¶РµС‚ РїРѕРєР°Р·Р°С‚СЊ ready, РЅРѕ РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚ РІС‹РґР°С‡Р° С„Р°Р№Р»Р°/URI РїРѕР»СЊР·РѕРІР°С‚РµР»СЋ.
- **РћР¶РёРґР°РµС‚СЃСЏ:** clipboard РїРѕСЃР»Рµ СѓСЃРїРµС€РЅРѕРіРѕ copy; СЌРєСЃРїРѕСЂС‚ РґРѕСЃС‚СѓРїРµРЅ С‡РµСЂРµР· Android document/share flow Р»РёР±Рѕ UI С‡РµСЃС‚РЅРѕ СЃРѕРѕР±С‰Р°РµС‚ РѕС‚СЃСѓС‚СЃС‚РІРёРµ РІРѕР·РјРѕР¶РЅРѕСЃС‚Рё.
- **РљРѕРѕСЂРґРёРЅР°С‚С‹ / РґРѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІРѕ:** `android_jni.rs:653вЂ“659` Р»РѕРіРёСЂСѓРµС‚ `clipboard_bridge_pending`; Android action dispatch `:599вЂ“600` РЅРµ РїРѕС‚СЂРµР±Р»СЏРµС‚ `LastExport`. `session/messages.rs:352вЂ“357`, `:371вЂ“372` РїР°СЂРєСѓСЋС‚ bytes Рё ready status; РІ Activity/JNI РЅРµС‚ `take_last_export` Рё ClipboardManager sink.
- **Р’РѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ:** Copy, РїСЂРѕРІРµСЂРёС‚СЊ clipboard; Export, РїСЂРѕРІРµСЂРёС‚СЊ РїРѕР»СѓС‡РµРЅРЅС‹Р№ document URI Рё bytes. РЈСЃС‚СЂРѕР№СЃС‚РІРѕ РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚, РїРѕРґС‚РІРµСЂР¶РґС‘РЅ СЂР°Р·СЂС‹РІ РІС‹Р·РѕРІРѕРІ.
- **РџСЂРёС‡РёРЅР°:** РѕР±С‰РёР№ action РїСЂРёСЃСѓС‚СЃС‚РІСѓРµС‚, РЅРѕ host capability contract РЅРµ Р·Р°РІРµСЂС€С‘РЅ.
- **РСЃРїСЂР°РІР»РµРЅРёРµ / Р·Р°РІРёСЃРёРјРѕСЃС‚Рё:** clipboard/document handoff, typed completion/error; availability РґРѕР»Р¶РЅР° РѕС‚СЂР°Р¶Р°С‚СЊСЃСЏ РІ UI. РСЃРїРѕР»СЊР·РѕРІР°С‚СЊ РѕР±С‰РёР№ capability РёРЅС‚РµСЂС„РµР№СЃ РІРјРµСЃС‚Рѕ РЅРѕРІС‹С… РЅРµР·Р°РІРёСЃРёРјС‹С… action РІРµС‚РѕРє.
- **РџСЂРёС‘РјРєР°:** clipboard payload СЃРѕРІРїР°РґР°РµС‚ СЃ СЃРѕРѕР±С‰РµРЅРёРµРј; export URI С‡РёС‚Р°РµС‚СЃСЏ Рё СЃРѕРґРµСЂР¶РёС‚ wire bytes; failures Р»РѕРєР°Р»РёР·РѕРІР°РЅС‹; СѓСЃРїРµС… С‚РѕР»СЊРєРѕ РїРѕСЃР»Рµ РїР»Р°С‚С„РѕСЂРјРµРЅРЅРѕРіРѕ РїРѕРґС‚РІРµСЂР¶РґРµРЅРёСЏ.

### PL-08 вЂ” P2 вЂ” Desktop export РЅРµР°С‚РѕРјР°СЂРµРЅ Рё С‚РµСЂСЏРµС‚ payload РїСЂРё РѕС€РёР±РєРµ

- **РЎС‚Р°С‚СѓСЃ / С…РѕСЃС‚С‹:** `STATIC_CONFIRMED`; native desktop. Fault injection runtime вЂ” `NOT_RUN`.
- **РЎРёРјРїС‚РѕРј:** direct overwrite РјРѕР¶РµС‚ РѕСЃС‚Р°РІРёС‚СЊ С‡Р°СЃС‚РёС‡РЅС‹Р№ С„Р°Р№Р»; write failure РѕСЃС‚Р°РІР»СЏРµС‚ ready status, РЅРѕ parked export СѓР¶Рµ СЃРЅСЏС‚.
- **РћР¶РёРґР°РµС‚СЃСЏ:** Р°С‚РѕРјР°СЂРЅР°СЏ Р·Р°РїРёСЃСЊ, СЏРІРЅР°СЏ РїРѕР»РёС‚РёРєР° existing file, РІРѕР·РјРѕР¶РЅРѕСЃС‚СЊ РїРѕРІС‚РѕСЂРёС‚СЊ СЃРѕС…СЂР°РЅРµРЅРёРµ Рё РєРѕСЂСЂРµРєС‚РЅС‹Р№ UI error.
- **РљРѕРѕСЂРґРёРЅР°С‚С‹ / РґРѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІРѕ:** `desktop_host/mod.rs:72вЂ“79` РёСЃРїРѕР»СЊР·СѓРµС‚ `std::fs::write` Р±РµР· temp/rename. `input.rs:719вЂ“727` РІС‹Р·С‹РІР°РµС‚ `take_last_export` РґРѕ Р·Р°РїРёСЃРё; Err С‚РѕР»СЊРєРѕ Р¶СѓСЂРЅР°Р»РёСЂСѓРµС‚СЃСЏ. `session/messages.rs:371вЂ“372` РґРµР»Р°РµС‚ `take()`.
- **Р’РѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ:** unwritable `NEOTA_EXPORT_DIR`, СЌРєСЃРїРѕСЂС‚, РїСЂРѕРІРµСЂРёС‚СЊ status Рё retry. РћС‚РґРµР»СЊРЅРѕ existing filename Рё crash/write fault injection РїСЂРѕРІРµСЂРёС‚СЊ СЃРѕС…СЂР°РЅРЅРѕСЃС‚СЊ РїСЂРµРґС‹РґСѓС‰РµРіРѕ С„Р°Р№Р»Р°.
- **РџСЂРёС‡РёРЅР°:** sink consumes payload РґРѕ РїРѕРґС‚РІРµСЂР¶РґРµРЅРёСЏ, РЅРµ РёРјРµРµС‚ transaction/error handoff.
- **РСЃРїСЂР°РІР»РµРЅРёРµ / Р·Р°РІРёСЃРёРјРѕСЃС‚Рё:** atomic temp+rename, explicit existing-file policy; consume РїРѕСЃР»Рµ success Р»РёР±Рѕ РІРѕСЃСЃС‚Р°РЅРѕРІРёС‚СЊ parked result; stable localized error. РћР±С‰РёР№ completion contract РїСЂРёРіРѕРґРµРЅ Android PL-07.
- **РџСЂРёС‘РјРєР°:** interrupted write СЃРѕС…СЂР°РЅСЏРµС‚ РїСЂРµР¶РЅРёР№ РїРѕР»РЅС‹Р№ С„Р°Р№Р»; retry РЅРµ РІС‹Р·С‹РІР°РµС‚ РЅРѕРІСѓСЋ wire export operation; РѕС€РёР±РєР° РЅРµ РІС‹РіР»СЏРґРёС‚ success.

## РћРіСЂР°РЅРёС‡РµРЅРёСЏ, РґРѕР»Рі Рё СЂРёСЃРєРё

### PL-L01 вЂ” P2 вЂ” Product glass/filter РЅРµ РёСЃРїРѕР»РЅСЏРµС‚СЃСЏ (`DOCUMENTED_LIMITATION`)

**РҐРѕСЃС‚С‹:** native desktop Рё Android. `presentation-m0-d2/src/vello_sink.rs:263вЂ“282` РёРіРЅРѕСЂРёСЂСѓРµС‚ `_filter`/`_backdrop_filter`. Desktop `produce.rs:254` СЂРµРЅРґРµСЂРёС‚ split scenes; Android `android_surface.rs:1651` вЂ” full scene. Р­С‚Рё product paths РЅРµ РёСЃРїРѕР»РЅСЏСЋС‚ NeoCompositor glass pass graph. Glass markers/tests РЅРµ РїРѕРґС‚РІРµСЂР¶РґР°СЋС‚ live blur. РћР¶РёРґР°РµРјРѕРµ Р±СѓРґСѓС‰РµРµ РїРѕРІРµРґРµРЅРёРµ вЂ” РґРёРЅР°РјРёС‡РµСЃРєРёР№ backdrop СЃ clip/effect semantics; С‚РµРєСѓС‰Р°СЏ РїСЂРёС‘РјРєР° РѕСЃС‚Р°С‘С‚СЃСЏ РѕС‚Р»РѕР¶РµРЅРЅРѕР№. РЎР»РµРґСѓСЋС‰РёР№ С€Р°Рі: СЃРІСЏР·Р°С‚СЊ capability СЃ СЂРµР°Р»СЊРЅС‹Рј executor Рё РѕС‚РґРµР»СЊРЅРѕ РїСЂРѕРІРµСЂРёС‚СЊ РґРІРёР¶СѓС‰РёР№СЃСЏ С†РІРµС‚РЅРѕР№ backdrop, blur setting, nested scopes РЅР° product hosts. Р—Р°РІРёСЃРёРјРѕСЃС‚СЊ: common presentation capability contract; РЅРµ РЅР°С‡РёРЅР°С‚СЊ СЃ СЂСѓС‡РЅРѕРіРѕ СЂР°Р·РјС‹С‚РёСЏ РѕС‚РґРµР»СЊРЅС‹С… РїР°РЅРµР»РµР№.

### PL-L02 вЂ” P2 вЂ” Р Р°Р·РѕС€РµРґС€РёРµСЃСЏ host pipelines (`ARCHITECTURAL_DEBT`)

**РҐРѕСЃС‚С‹:** desktop Рё Android. Desktop `produce.rs:148вЂ“172` СЃРѕС…СЂР°РЅСЏРµС‚ VDOM Рё РґРµР»Р°РµС‚ `paint_split`/overscan; Android `android_surface.rs:1627вЂ“1631` cold-opens Рё РґРµР»Р°РµС‚ full paint. Input/export/stream driving С‚Р°РєР¶Рµ СЂР°Р·Р»РёС‡Р°СЋС‚СЃСЏ. Docstring `bin/neocompositor-desktop.rs:3вЂ“8` Рё [РѕРїРёСЃР°РЅРёРµ С…РѕСЃС‚Р°](../../desktop/neocompositor-desktop-host.md) РїРµСЂРµРѕС†РµРЅРёРІР°СЋС‚ РёРґРµРЅС‚РёС‡РЅРѕСЃС‚СЊ. РћР¶РёРґР°РµС‚СЃСЏ С‚РѕС‡РЅР°СЏ РєР°СЂС‚Р° РѕР±С‰РёС… invariants Рё РѕС‚РґРµР»СЊРЅС‹С… adapters. РЎР»РµРґСѓСЋС‰РёР№ С€Р°Рі: РѕР±С‰Р°СЏ orchestration abstraction РґР»СЏ lifecycle Рё contract tests РѕР±РѕРёС… adapters, Р·Р°С‚РµРј РѕР±РЅРѕРІР»РµРЅРёРµ РґРѕРєСѓРјРµРЅС‚Р°С†РёРё. РџСЂРёС‘РјРєР°: desktop fix РЅРµ РїРѕР»СѓС‡Р°РµС‚ Android PASS Р±РµР· РІС‹РїРѕР»РЅРµРЅРёСЏ СЃРѕРѕС‚РІРµС‚СЃС‚РІСѓСЋС‰РµРіРѕ adapter С‚РµСЃС‚Р°/physical gate.

### PL-L03 вЂ” P2 вЂ” Arena GC workaround Рё patch-map РґРѕР»Рі (`ARCHITECTURAL_DEBT`)

**РҐРѕСЃС‚С‹:** retained desktop producer; Android cold-opens РєР°Р¶РґС‹Р№ bind. `vendor/blitz-dom/NEOTAVERN_PATCH.md` РґРѕРєСѓРјРµРЅС‚РёСЂСѓРµС‚ no-op GC РґР»СЏ alpha ID recycling. `desktop_host/produce.rs:392вЂ“408` РѕРіСЂР°РЅРёС‡РёРІР°РµС‚ retained arena 8192 nodes Рё cold-reopen СЃР»РµРґСѓСЋС‰РµРіРѕ produce. Р­С‚Рѕ bounded workaround, РЅРµ РґРѕРєР°Р·Р°РЅРЅС‹Р№ unbounded leak. РЎР»РµРґСѓСЋС‰РёР№ С€Р°Рі: РїРѕР»РЅС‹Р№ patch inventory, regression РїСЂРё РїРµСЂРµСЂР°Р±РѕС‚РєРµ upstream GC, soak RSS/private bytes Рё long-frame metrics. РџСЂРёС‘РјРєР°: СЂРѕСЃС‚ РїР°РјСЏС‚Рё РѕРіСЂР°РЅРёС‡РµРЅ Рё cold-reopen СЃС‚РѕРёРјРѕСЃС‚СЊ РёР·РјРµСЂРµРЅР°; СѓСЃС‚СЂР°РЅРµРЅРёРµ workaround С‚РѕР»СЊРєРѕ РїРѕСЃР»Рµ behavioral id-recycling regression. Р—Р°РІРёСЃРёРјРѕСЃС‚СЊ: СЃРѕРІРјРµСЃС‚РёРјР°СЏ РёСЃРїСЂР°РІР»РµРЅРЅР°СЏ producer seam, Р±РµР· СЃРјРµРЅС‹ СЃС‚РµРєР°.

### PL-L04 вЂ” P2 вЂ” Image kill-switch РјРµРЅСЏРµС‚ paint-order invariant (`DOCUMENTED_LIMITATION`)

**РҐРѕСЃС‚С‹:** desktop Рё Android РїСЂРё `NEOTA_INSCENE_IMAGES=0`. Default in-scene images РёСЃРїСЂР°РІР»РµРЅС‹; fallback `produce.rs:373вЂ“383`, `android_surface.rs:1338вЂ“1359` РєРѕРјРїРѕР·РёС‚РёС‚ avatars РїРѕСЃР»Рµ РєР°РґСЂР° Рё РЅРµ Р·РЅР°РµС‚ modal z-order/full clip chains. РћР¶РёРґР°РµС‚СЃСЏ С‡РµСЃС‚РЅС‹Р№ degraded status. Р’РѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ: switch off, avatar РїРѕРґ modal/scroll clip, capture; РІ СЌС‚РѕРј Р°СѓРґРёС‚Рµ fallback runtime РЅРµ Р·Р°СЃС‡РёС‚С‹РІР°РµС‚СЃСЏ. РЎР»РµРґСѓСЋС‰РёР№ С€Р°Рі: СЏРІРЅРѕРµ capability РѕРіСЂР°РЅРёС‡РµРЅРёРµ Рё РѕС‚РґРµР»СЊРЅС‹Рµ overlay regressions. РџСЂРёС‘РјРєР°: fallback РЅРµ РѕР±СЉСЏРІР»СЏРµС‚СЃСЏ parity; РІРѕР·РІСЂР°С‚ Рє default scene path РїСЂРѕРІРµСЂРµРЅ. РќРµ СѓРґР°Р»СЏС‚СЊ Р·Р°С‰РёС‚РЅС‹Р№ switch Р±РµР· С„РёР·РёС‡РµСЃРєРѕРіРѕ driver evidence.

### PL-R01 вЂ” P2 вЂ” РќРµРїРѕР»РЅС‹Р№ presentation JNI panic guard (`RISK_NOT_REPRODUCED`)

**РҐРѕСЃС‚С‹:** Android presentation JNI. `openRoute:342` РёСЃРїРѕР»СЊР·СѓРµС‚ catch_unwind, Р° РґСЂСѓРіРёРµ `extern "system"` entrypoints (`send`, `pollStream`, `presentFrame`) РІС‹Р·С‹РІР°СЋС‚ `with_route:296вЂ“306` Р±РµР· РѕР±С‰РµРіРѕ unwind guard. `bind_from_session` catch-РёС‚ bind РѕС‚РґРµР»СЊРЅРѕ. Р’РѕР·РјРѕР¶РЅС‹Р№ abort РїСЂРё РїР°РЅРёРєРµ mutation/mount РЅРµ РІРѕСЃРїСЂРѕРёР·РІРµРґС‘РЅ. РЎР»РµРґСѓСЋС‰РёР№ С€Р°Рі: panic injection РЅР° ABI boundary; typed stable error Рё last-known-good recovery РґР»СЏ РІСЃРµС… entrypoints. РџСЂРёС‘РјРєР°: panics РЅРµ РїРµСЂРµСЃРµРєР°СЋС‚ JNI Рё РЅРµ abort-СЏС‚ РїСЂРѕС†РµСЃСЃ. Kernel JNI transport PASS РЅРµ Р·Р°РјРµРЅСЏРµС‚ СЌС‚РѕС‚ С‚РµСЃС‚.

### PL-R02 вЂ” P2 вЂ” Teardown Рё stream callbacks С‚СЂРµР±СѓСЋС‚ lifecycle guard (`RISK_NOT_REPRODUCED`)

**РҐРѕСЃС‚С‹:** Android. `Activity:405вЂ“415` Р·Р°РІРµСЂС€Р°РµС‚ handler Рё holder; `pollStreamingBounded:719` post-РёС‚ executor work Р±РµР· РѕР±С‰РµРіРѕ closed/lifecycle token. РџРѕСЃР»Рµ shutdown РІРѕР·РјРѕР¶РµРЅ rejected enqueue; С‚Р°РєРѕР№ crash РЅРµ РІРѕСЃРїСЂРѕРёР·РІРµРґС‘РЅ. Rust UI calls РЅР° compositor callback РёРґСѓС‚ РЅР°РїСЂСЏРјСѓСЋ РІ Kotlin KernelSession, РЅРµСЃРјРѕС‚СЂСЏ РЅР° РѕР±РµС‰Р°РЅРёРµ Kotlin polling comment Рѕ holder executor. РЎР»РµРґСѓСЋС‰РёР№ С€Р°Рі: РµРґРёРЅР°СЏ ownership/serialization РїРѕР»РёС‚РёРєР°, cancel callback token, stress rotation/background/finish РІРѕ РІСЂРµРјСЏ stream. РџСЂРёС‘РјРєР°: РЅРµС‚ callbacks РїРѕСЃР»Рµ Р·Р°РєСЂС‹С‚РёСЏ, rejected enqueue/РёСЃРїРѕР»СЊР·РѕРІР°РЅРёСЏ СЃС‚Р°СЂРѕР№ session Рё main-thread wait. РЎРІСЏР·Р°РЅРѕ СЃ PL-04/05.

### PL-R03 вЂ” P2 вЂ” Adapter qualification СЌРІСЂРёСЃС‚РёС‡РЅР° (`RISK_NOT_REPRODUCED`)

`vello_gpu.rs:193вЂ“201` РёСЃРєР»СЋС‡Р°РµС‚ emulator Vulkan РїРѕ РїРѕРґСЃС‚СЂРѕРєР°Рј РёРјРµРЅРё; `adapter_sort_key:204вЂ“216` СЂР°РЅР¶РёСЂСѓРµС‚ backend СЂР°РЅСЊС€Рµ CPU type. РќРѕРІС‹Р№ emulator/software adapter РјРѕР¶РµС‚ РЅРµ СЃРѕРІРїР°СЃС‚СЊ СЃ РёРјРµРЅРµРј. Р­С‚Рѕ РЅРµ РґРѕРєР°Р·Р°РЅРЅР°СЏ РѕС€РёР±РєР° С‚РµРєСѓС‰РµРіРѕ Vulkan СѓСЃС‚СЂРѕР№СЃС‚РІР°. РЎР»РµРґСѓСЋС‰РёР№ С€Р°Рі: capability/driver evidence Рё tests РЅР° РЅРµРёР·РІРµСЃС‚РЅРѕРµ РёРјСЏ/CPU renderer. РџСЂРёС‘РјРєР°: software/emulator РЅРµ РїРѕР»СѓС‡Р°РµС‚ physical GPU qualification С‚РѕР»СЊРєРѕ РїРѕ СѓРґР°С‡РЅРѕРјСѓ СЃРѕР·РґР°РЅРёСЋ surface.

## РџРѕРєСЂС‹С‚РёРµ Р°РґР°РїС‚РµСЂРѕРІ Рё РЅРµР·Р°РєСЂС‹С‚С‹Рµ СЃС†РµРЅР°СЂРёРё

| РћР±Р»Р°СЃС‚СЊ             | Desktop native                                                                              | Android canary                                                | РЎР»РµРґСѓСЋС‰РµРµ РґРѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІРѕ                              |
| -------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Pointer/hit-test           | Native feature tests PASS; layout Рё geometric paths РѕС‚РґРµР»СЊРЅС‹                       | РЎС‚Р°С‚РёС‡РµСЃРєРё inspect; physical `NOT_RUN`              | РћРґРёРЅ frame geometry РґР»СЏ render, focus Рё actions; overlap/slop/cancel |
| Physical keyboard/editor   | `STATIC_CONFIRMED` PL-01; CLI setter РЅРµ OS test                                           | PL-03; physical `NOT_RUN`                                     | Caret/selection/IME/shortcuts РЅР° СѓСЃС‚СЂРѕР№СЃС‚РІРµ                      |
| Clipboard                  | OS sink СЂРµР°Р»РёР·РѕРІР°РЅ; runtime clipboard `NOT_RUN`                                   | PL-07 no-op                                                   | РџСЂРѕС‡РёС‚Р°С‚СЊ clipboard РїРѕСЃР»Рµ UI РґРµР№СЃС‚РІРёСЏ, failure path    |
| File import/export         | Path-input СЂСѓС‡РЅРѕР№; export PL-08                                                       | Export sink РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚ PL-07                      | Dialog/path permission, cancellation, atomic write, retry                    |
| Streaming                  | РЎРІРµР¶РёР№ live-wire probe; РЅРµ РІСЃРµ user input paths                                  | PL-04/05; physical `NOT_RUN`                                  | Slow first token, long run, cancel, route change                             |
| Accessibility              | РќР°СЂРёСЃРѕРІР°РЅРЅС‹Р№ UI; native OS semantics РЅРµ РїРѕРґС‚РІРµСЂР¶РґРµРЅС‹              | PL-06; TalkBack `NOT_RUN`                                     | Semantic nodes, actions, keyboard focus Рё RTL bounds                        |
| Insets/DPI/resize          | Captures РЅР° РїСЂРѕРІРµСЂРµРЅРЅС‹С… СЂР°Р·РјРµСЂР°С…; РЅРµ РІСЃРµ DPI                      | Cached insets inspect; physical `NOT_RUN`                     | Late insets, IME animation, safe-area, rotation                              |
| Lifecycle/Surface recreate | Window lifecycle inspect; no cross-OS PASS                                                  | PL-R02; background/resume/rotation/Surface recreate `NOT_RUN` | Streaming during teardown/recreate, device loss recovery                     |
| JNI/FFI                    | Core/transport tests PASS РѕС‚РЅРѕСЃСЏС‚СЃСЏ Рє СЃРІРѕРёРј boundaries                       | Presentation guard PL-R01; physical `NOT_RUN`                 | Panic/stale handles/cancellation РЅР° presentation boundary                  |
| GPU images/clip/z-order    | Default fresh Vulkan captures; fallback PL-L04                                              | Source implemented; physical `NOT_RUN`                        | Modal stacking, image atlas recovery, driver-specific switch                 |
| Glass/filter               | PL-L01 deferred                                                                             | PL-L01 deferred                                               | Р РµР°Р»СЊРЅС‹Рµ blur pixels, nested scopes Рё scrolling backdrop            |
| Safe mode                  | Legacy chrome escape РёРјРµРµС‚СЃСЏ; third-party lifecycle РЅРµ РїРѕРґС‚РІРµСЂР¶РґС‘РЅ РёРј | Canary policy РёРјРµРµС‚ safe-mode WebView fallback           | Theme/plugin disable cleanup Рё reset, РѕС‚РґРµР»СЊРЅРѕ РѕС‚ chrome switch   |
| Frame pacing/memory        | Capture РЅРµ perf; РѕС‚РґРµР»СЊРЅС‹Рµ measurements РІ VERIFICATION                          | Physical `NOT_RUN`                                            | No-capture frame intervals/soak/device epoch pressure                        |

РЎРІРµР¶РёР№ FakeWire first produce РёР·РјРµСЂРµРЅ РѕСЃРЅРѕРІРЅС‹Рј Р°СѓРґРёС‚РѕРј РїСЂРёРјРµСЂРЅРѕ РІ 1067 ms; working set 185,5 MiB, private bytes 653,4 MiB. Р­С‚Рѕ РІРµСЃСЊ native host, РїРѕСЌС‚РѕРјСѓ РµРіРѕ РЅРµР»СЊР·СЏ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё СЃСЂР°РІРЅРёРІР°С‚СЊ СЃ backend-idle 180 MB. РћС‚РґРµР»СЊРЅС‹Р№ headless sample: ready HTTP meta 153,9 ms, idle working set 11,2 MiB/private 5,3 MiB; РѕРЅ РЅРµ РѕРїРёСЃС‹РІР°РµС‚ СЃС‚РѕРёРјРѕСЃС‚СЊ РіСЂР°С„РёС‡РµСЃРєРѕРіРѕ frontend. Р­С‚Рё samples РЅРµ РґРѕРєР°Р·С‹РІР°СЋС‚ РІСЃРµ target metrics Рё РЅРµ Р·Р°РјРµРЅСЏСЋС‚ frame-pacing trace.

## Р—Р°РІРёСЃРёРјРѕСЃС‚Рё alpha/beta Рё С‡РµС‚С‹СЂРµ Р°РєС‚СѓР°Р»СЊРЅС‹С… vendor patches

`presentation-m0-d2/Cargo.toml` Рё `crates/Cargo.lock` С„РёРєСЃРёСЂСѓСЋС‚ Dioxus/native-dom `0.8.0-alpha.1`, Blitz `0.3.0-beta.1`, anyrender `0.11.0`, Vello `0.9.0`; GPU host РёСЃРїРѕР»СЊР·СѓРµС‚ wgpu `29.0.3`. РЎР°Рј prerelease СЃС‚Р°С‚СѓСЃ РЅРµ РґРµС„РµРєС‚. Р’Р°Р¶РЅС‹ РїРѕСЃР»РµРґСЃС‚РІРёСЏ API/GC РїРѕРІРµРґРµРЅРёСЏ Рё РїСЂРѕРІРµСЂРєР° seam РЅР° РѕР±РЅРѕРІР»РµРЅРёРё.

| Patch РІ `crates/Cargo.toml` | Р РµР°Р»СЊРЅР°СЏ СЂРѕР»СЊ                                                                    | РћРіСЂР°РЅРёС‡РµРЅРёРµ / СЃР»РµРґСѓСЋС‰РёР№ С€Р°Рі                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `anyrender`                  | Host node/text fragment markers, chrome route                                                | РЎРѕС…СЂР°РЅСЏС‚СЊ paint order; РїСЂРѕРІРµСЂСЏС‚СЊ application/rebase Рё backwards no-op hooks                                                |
| `blitz-paint`                | Emit host markers РёР· paint traversal, shaped text replay, chrome routing, expanded culling | РќРµ СЃС‡РёС‚Р°С‚СЊ marker РёСЃРїРѕР»РЅРµРЅРёРµРј glass; РїСЂРѕРІРµСЂСЏС‚СЊ split/clip/order behavioral regressions                           |
| `blitz-dom`                  | No-op arena GC, node count, defensive dead-parent guard                                      | Bounded cold-reopen PL-L03; GC workaround СѓР¶Рµ С€РёСЂРµ РїРµСЂРІРѕРЅР°С‡Р°Р»СЊРЅРѕР№ two-patch РєР°СЂС‚С‹                                   |
| `vello`                      | Shader-bounds diagnostic hook; default upstream unchecked                                    | Р”РёР°РіРЅРѕСЃС‚РёС‡РµСЃРєРѕРµ A/B РЅРµ СЂР°РІРЅРѕ СѓСЃС‚СЂР°РЅС‘РЅРЅРѕРјСѓ driver defect; СЃРѕС…СЂР°РЅСЏС‚СЊ РѕС‚РґРµР»СЊРЅС‹Рµ GPU evidence |

Р”РѕРєСѓРјРµРЅС‚С‹ `upstream seam` Рё [vendor README](../../../crates/vendor/README.md) РЅРµ РґР°СЋС‚ РїРѕР»РЅРѕРіРѕ РµРґРёРЅРѕРіРѕ РѕРїРёСЃР°РЅРёСЏ С‡РµС‚С‹СЂС‘С… patches. `blitz-dom patch` С‡РµСЃС‚РЅРѕ РѕРїРёСЃС‹РІР°РµС‚ РѕС‚РєР»СЋС‡РµРЅРёРµ GC Рё containment. РўСЂРµР±СѓРµС‚СЃСЏ РµРґРёРЅР°СЏ РєР°СЂС‚Р° РІРµСЂСЃРёРё, exact diff, owner, exit criteria Рё test РґР»СЏ РєР°Р¶РґРѕРіРѕ patch, Р±РµР· РѕР±РµС‰Р°РЅРёСЏ РЅРµРјРµРґР»РµРЅРЅРѕ СѓРґР°Р»РёС‚СЊ СЂР°Р±РѕС‡СѓСЋ Р·Р°С‰РёС‚Сѓ.

## РџРµСЂРµРїСЂРѕРІРµСЂРєР° РїСЂРµР¶РЅРёС… Р°СѓРґРёС‚РѕРІ

РћСЃРЅРѕРІР°РЅРёСЏ: [РєР°С‚Р°Р»РѕРі v4](../../../audit-neoui-v4/11-BUGS-AND-HACKS-CATALOG.md), [security v4](../../../audit-neoui-v4/10-SECURITY-VULNERABILITIES.md), [visual v4](../../../audit-neoui-v4/04-VISUAL-PARITY-GLASS.md), [image pipeline audit](../../desktop/native-image-pipeline-audit.md). `Resolved` РЅРёР¶Рµ РѕР·РЅР°С‡Р°РµС‚ РЅР°Р»РёС‡РёРµ РёСЃРїСЂР°РІР»РµРЅРёСЏ РІ С‚РµРєСѓС‰РµРј РєРѕРґРµ, Р° РЅРµ РЅРѕРІРѕРµ С„РёР·РёС‡РµСЃРєРѕРµ PASS.

| РџСЂРµР¶РЅСЏСЏ РЅР°С…РѕРґРєР°               | РўРµРєСѓС‰Р°СЏ РѕС†РµРЅРєР°                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v4 P0-01 native views alpha=.01             | `RESOLVED_IN_CODE`: header/messages/send overlay СѓРґР°Р»С‘РЅ; Р·Р°РјРµРЅР° РёРјРµРµС‚ PL-03/06                                                                                                             |
| v4 P1-02 naive CSS flatten                  | `PARTIALLY_RESOLVED`: nested calc/max/min/clamp Рё strings/comments РїРѕРґРґРµСЂР¶Р°РЅС‹; general CSS grammar limitation РѕСЃС‚Р°С‘С‚СЃСЏ                                                                   |
| v4 P1-03 unbounded avatar cache             | `RESOLVED_IN_CODE`: GPU 64 entries/8 MiB, pressure/epoch; AssetStore 64/32 MiB; physical budgets РЅРµ РёР·РјРµСЂРµРЅС‹                                                                                      |
| v4 P1-04 image decode Р±РµР· preflight      | `RESOLVED_IN_CODE`: input 16 MiB, axis 4096, 16M pixels, header dimensions РґРѕ raster decode (`avatar.rs:24вЂ“65`)                                                                                         |
| v4 P1-05 40Г—poll HOL                       | `PARTIALLY_RESOLVED`: Kotlin loop yielding; PL-04/05 РѕСЃС‚Р°СЋС‚СЃСЏ                                                                                                                                       |
| v4 P2-06 emulator substring                 | `PERSISTS`, PL-R03; РЅРѕРІС‹Р№ runtime failure РЅРµ РґРѕРєР°Р·Р°РЅ                                                                                                                                          |
| v4 P2-07 cssPx truncation                   | `RESOLVED_IN_CODE`: `MainActivity.kt:420вЂ“424`, roundToInt                                                                                                                                                 |
| v4 P2-08 ellipsize heuristic                | `PERSISTS`: `product_shell.rs:304вЂ“325`                                                                                                                                                                    |
| v4 P2-09 late insets                        | `MITIGATED_IN_CODE`: cache pushed РїРµСЂРµРґ present loop (`Activity:467вЂ“470`); no-jump physical `NOT_RUN`                                                                                                |
| v4 P2-10 hasWebView recursion               | `PERSISTS`, РЅРёР·РєРёР№ СЂРёСЃРє С‚РµРєСѓС‰РµРіРѕ РїР»РѕСЃРєРѕРіРѕ РґРµСЂРµРІР°                                                                                                                            |
| v4 P2-11 holder hot-restart                 | `NOT_VERIFIED`: С‚СЂРµР±СѓРµС‚ lifecycle stress, PL-R02                                                                                                                                                     |
| v4 P3-12 missing README                     | РќР°Р·РЅР°С‡РµРЅРЅС‹Рµ presentation crates РёРјРµСЋС‚ README; СЌС‚Рѕ РЅРµ review Р°РєС‚СѓР°Р»СЊРЅРѕСЃС‚Рё РІСЃРµС… РїСЂРёРјРµСЂРѕРІ                                                                         |
| Broad cleartext                             | `DOCUMENTED_LIMITATION`: РїСЂРѕРёР·РІРѕР»СЊРЅС‹Рµ LAN literal IPs; narrowing С‚СЂРµР±СѓРµС‚ РѕС‚РґРµР»СЊРЅРѕР№ РїСЂРёРЅСЏС‚РѕР№ РїРѕР»РёС‚РёРєРё, РЅРµ РѕР±СЉСЏРІР»СЏС‚СЊ РЅРѕРІСѓСЋ critical vulnerability |
| Image Stage A fit/radius/snap/mips          | `RESOLVED_IN_CODE`                                                                                                                                                                                          |
| Image Stage B in-scene/avatar/message asset | `RESOLVED_IN_CODE` default; Android Vulkan physical `NOT_RUN`; kill-switch PL-L04                                                                                                                           |
| Image Stage C fixed wallpaper/kernel thumbs | Desktop `RESOLVED_IN_CODE`; Android wallpaper РЅРµ РїРѕРґРєР»СЋС‡С‘РЅ                                                                                                                                       |
| 192px gallery upscale                       | `DOCUMENTED_LIMITATION_PERSISTS`, `AVATAR_DISPLAY_MAX_PX=192`                                                                                                                                               |
| Remote markdown images/SVG                  | `DOCUMENTED_LIMITATION_PERSISTS`; local raster asset path СЂРµР°Р»РёР·РѕРІР°РЅ                                                                                                                              |
| Per-produce decode                          | Desktop retained session РёР·РјРµРЅРёР» РїСѓС‚СЊ; Android cold-open СЃРѕС…СЂР°РЅРёР»СЃСЏ; performance `NOT_RUN` РґР»СЏ РїРѕР»РЅРѕР№ РјР°С‚СЂРёС†С‹                                                          |

## РћС‡РµСЂРµРґРЅРѕСЃС‚СЊ РёСЃРїСЂР°РІР»РµРЅРёР№ Рё РіСЂР°РЅРёС†Р° Р·Р°РІРµСЂС€РµРЅРёСЏ

1. РЈРґР°Р»РёС‚СЊ logging С‚РµРєСЃС‚Р° PL-02; Р°С‚РѕРјР°СЂРЅРѕСЃС‚СЊ/error handoff СЌРєСЃРїРѕСЂС‚РѕРІ PL-08.
2. РЈСЃС‚Р°РЅРѕРІРёС‚СЊ РѕР±С‰СѓСЋ input/semantics РјРѕРґРµР»СЊ, Р·Р°С‚РµРј Р·Р°РєСЂС‹С‚СЊ PL-01/03/06 Рё capability sinks PL-07.
3. Р•РґРёРЅС‹Р№ stream lifecycle Рё РЅРµР±Р»РѕРєРёСЂСѓСЋС‰РёР№ СЃС‚Р°СЂС‚ PL-04/05; lifecycle guards Рё presentation JNI panic tests PL-R01/02.
4. Р—Р°РєСЂРµРїРёС‚СЊ РѕР±С‰РёРµ host invariants Рё РѕС‚РґРµР»СЊРЅС‹Рµ adapter contracts PL-L02; С‡РµСЃС‚РЅРѕРµ capability РёСЃРїРѕР»РЅРµРЅРёРµ glass PL-L01 Рё degraded overlay PL-L04.
5. РџРѕСЃР»Рµ behavioral correctness РёР·РјРµСЂРёС‚СЊ no-capture frame pacing, cold-reopen soak Рё physical Android GPU/insets/rotation.

РќРµ РѕР±СЉСЏРІР»СЏС‚СЊ full-platform PASS РґРѕ С„РёР·РёС‡РµСЃРєРёС… Android/macOS/Linux РїСЂРѕРіРѕРЅРѕРІ Рё packaged Tauri validation. РСЃРїСЂР°РІР»РµРЅРёСЏ РїРµСЂРµС‡РёСЃР»РµРЅС‹ РєР°Рє Р±СѓРґСѓС‰РёРµ Р·Р°РґР°С‡Рё: Р°СѓРґРёС‚ РЅРµ РјРµРЅСЏР» СЂРµР°Р»РёР·Р°С†РёСЋ, API, РґР°РЅРЅС‹Рµ, РјРёРіСЂР°С†РёРё РёР»Рё СЃРѕРІРјРµСЃС‚РёРјРѕСЃС‚СЊ.
