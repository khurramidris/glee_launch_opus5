# Third-party notices

Glee's own source code is licensed under the [MIT License](LICENSE). Glee
downloads and uses the following third-party components, which keep their own
licenses. License texts are included with the app under `legal/third-party/`.

| Component | Used for | License | Source |
| --- | --- | --- | --- |
| Ternary Bonsai 2 4B (Q2_0 GGUF) by PrismML, based on Qwen3.5-4B | Chat model, downloaded on first run | Apache-2.0 | <https://huggingface.co/prism-ml/Ternary-Bonsai-2-4B-gguf> |
| BGE Small EN v1.5 (GGUF conversion by CompendiumLabs) | Memory search embeddings, downloaded on first run | MIT | <https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf> |
| llama.cpp, PrismML fork (`prism-b10777-e3de715`) | Local inference engine, downloaded on first run | MIT | <https://github.com/PrismML-Eng/llama.cpp> |
| LLVM OpenMP runtime (`libomp140`, Windows engine only) | Parallel CPU inference | Apache-2.0 WITH LLVM-exception | <https://github.com/llvm/llvm-project> |
| sqlite-vec | Vector search inside SQLite (compiled into Glee) | MIT OR Apache-2.0 | <https://github.com/asg017/sqlite-vec> |
| SQLite | Local database (compiled into Glee) | Public domain | <https://sqlite.org> |
| Tauri | Desktop application framework | MIT OR Apache-2.0 | <https://tauri.app> |
| Microsoft Edge WebView2 (Windows) | Renders the interface | Microsoft software license | <https://developer.microsoft.com/microsoft-edge/webview2/> |
| React, Zustand, and other npm/Cargo dependencies | Application code | MIT and compatible permissive licenses | See `package.json` and `src-tauri/Cargo.toml` |

The Ternary Bonsai 2 model is distributed by PrismML under the Apache License
2.0; see the `LICENSE` and `NOTICE.txt` files in its Hugging Face repository.
