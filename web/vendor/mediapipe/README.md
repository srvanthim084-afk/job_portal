# Self-hosted MediaPipe (face landmarks for the AI interview)

Used by `web/teamlink-interview-integrity.js` to count faces and read the mouth shape (blendshapes) from the
candidate's camera: second person, camera hidden, lips against the voice. The browser never calls a CDN for it -
the page's Content-Security-Policy only allows its own origin (plus `'wasm-unsafe-eval'` for the .wasm).

| File | Source | SHA-256 |
|---|---|---|
| `vision_bundle.mjs` | npm `@mediapipe/tasks-vision@0.10.14` | e77f281f9619150d937023c355bae170e9120e3b9e43f1e23a2a7bee07197669 |
| `wasm/vision_wasm_internal.js` | same package | 9440cf0cc0cea21800e31581ec32aeedcc5fbf9df4509796bbc7d3f99e52ab9c |
| `wasm/vision_wasm_internal.wasm` | same package | f82a8e6c05e08a44cc9f9e7ec5f845935bcbb1b1500ebe8c2f4812fb4e2917dc |
| `models/face_landmarker.task` | Google MediaPipe models, `face_landmarker/float16/1` | 64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff |

Only the SIMD build of the wasm is included (every current browser has SIMD). To update, replace the files with the
same names from a newer pinned version and refresh the hashes here.
