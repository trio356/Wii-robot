# Porcupine custom keywords — DROP YOUR .ppn FILES HERE

You trained these in the Picovoice console. Download the **Android**
variants and place them with EXACTLY these names:

  assets/porcupine/hey-wii.ppn       <- "Hey Wii"
  assets/porcupine/hey-william.ppn   <- "Hey William"

Why exact names: `src/voice/porcupineAssets.ts` requires them statically.
Metro cannot bundle the app until both files exist (you will get a clear
"Unable to resolve module" error naming the missing file).

Platform note: .ppn files are platform-specific. The ones above must be the
Android builds. If you later build for iOS, add a second pair and extend
`porcupineAssets.ts` with `Platform.select`.
