use wasm_bindgen::prelude::*;
use web_sys::{
    Event, SpeechRecognition, SpeechRecognitionAlternative, SpeechRecognitionEvent,
    SpeechRecognitionResult,
};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);

    #[wasm_bindgen(js_namespace = window)]
    fn onWasmSpeechResult(speaker: &str, content: &str, timestamp: f64, is_final: bool);
}

#[wasm_bindgen]
pub struct RustSpeechRecognizer {
    recognition: SpeechRecognition,
    speaker_name: String,
    is_listening: bool,
    _onresult_closure: Option<Closure<dyn FnMut(SpeechRecognitionEvent)>>,
    _onerror_closure: Option<Closure<dyn FnMut(Event)>>,
}

#[wasm_bindgen]
impl RustSpeechRecognizer {
    #[wasm_bindgen(constructor)]
    pub fn new(speaker_name: String) -> Result<RustSpeechRecognizer, JsValue> {
        let recognition = SpeechRecognition::new()?;
        recognition.set_continuous(true);
        recognition.set_interim_results(true);
        recognition.set_lang("ko-KR");

        log(&format!(
            "🦀 [Rust web-sys WASM] SpeechRecognizer initialized for '{}'",
            speaker_name
        ));

        Ok(RustSpeechRecognizer {
            recognition,
            speaker_name,
            is_listening: false,
            _onresult_closure: None,
            _onerror_closure: None,
        })
    }

    pub fn start(&mut self) -> Result<(), JsValue> {
        if self.is_listening {
            return Ok(());
        }

        let speaker = self.speaker_name.clone();

        // Bind onresult event callback in Rust using web-sys
        let onresult_closure = Closure::wrap(Box::new(move |event: SpeechRecognitionEvent| {
            if let Some(results) = event.results() {
                let len = results.length();

                let mut final_transcript = String::new();
                let mut interim_transcript = String::new();

                for i in event.result_index()..len {
                    let result: SpeechRecognitionResult = results.item(i);
                    let alt: SpeechRecognitionAlternative = result.item(0);
                    let text = alt.transcript();

                    if result.is_final() {
                        final_transcript.push_str(&text);
                    } else {
                        interim_transcript.push_str(&text);
                    }
                }

                let active_text = if !final_transcript.is_empty() {
                    &final_transcript
                } else {
                    &interim_transcript
                };

                let trimmed = active_text.trim();
                if !trimmed.is_empty() {
                    let is_final = !final_transcript.is_empty();
                    let now = js_sys::Date::now();

                    // Call JS bridge function to broadcast and display live captions
                    onWasmSpeechResult(&speaker, trimmed, now, is_final);
                }
            }
        }) as Box<dyn FnMut(SpeechRecognitionEvent)>);

        self.recognition
            .set_onresult(Some(onresult_closure.as_ref().unchecked_ref()));
        self._onresult_closure = Some(onresult_closure);

        // Bind onerror callback
        let onerror_closure = Closure::wrap(Box::new(move |event: Event| {
            log(&format!(
                "⚠️ [Rust web-sys WASM] Speech recognition error: {:?}",
                event.type_()
            ));
        }) as Box<dyn FnMut(Event)>);

        self.recognition
            .set_onerror(Some(onerror_closure.as_ref().unchecked_ref()));
        self._onerror_closure = Some(onerror_closure);

        self.recognition.start()?;
        self.is_listening = true;
        log("🎙️ [Rust web-sys WASM] STT Recognition started!");
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), JsValue> {
        if self.is_listening {
            let _ = self.recognition.stop();
            self.is_listening = false;
            log("🛑 [Rust web-sys WASM] STT Recognition stopped");
        }
        Ok(())
    }
}
