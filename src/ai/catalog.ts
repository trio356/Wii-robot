/**
 * Downloadable brain catalog. Default is the smallest fully-open option;
 * others are one tap away in Settings. URLs are full HuggingFace resolve
 * links so ModelManager needs no per-host logic. `md5` is optional: when
 * present the file is checksummed, otherwise size is verified.
 */

export interface BrainModel {
  id: string;
  label: string;
  params: string;
  quant: string;
  url: string;
  fileName: string;
  /** Approximate bytes; verification tolerates ±1 MB (hosts vary). */
  sizeBytes: number;
  md5?: string;
  /** Minimum total device RAM to even offer this model. */
  minRamBytes: number;
  /** Backstop stop-sequences (native template EOS usually fires first). */
  stop: string[];
}

export const BRAIN_MODELS: BrainModel[] = [
  {
    id: 'qwen25-0.5b-q4km',
    label: 'Qwen 2.5 0.5B (default)',
    params: '0.5B',
    quant: 'Q4_K_M',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
    fileName: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    sizeBytes: 397_000_000,
    minRamBytes: 2_000_000_000,
    stop: ['<|im_end|>', '<|endoftext|>'],
  },
  {
    id: 'llama32-1b-q4km',
    label: 'Llama 3.2 1B',
    params: '1B',
    quant: 'Q4_K_M',
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    fileName: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    sizeBytes: 807_000_000,
    minRamBytes: 3_000_000_000,
    stop: ['<|eot_id|>', '<|end_of_text|>'],
  },
  {
    id: 'gemma3-1b-qat',
    label: 'Gemma 3 1B QAT',
    params: '1B',
    quant: 'Q4_0 QAT',
    // Gated license: HuggingFace login required, so direct download needs a
    // token. Verify the exact filename on the model page before downloading.
    url: 'https://huggingface.co/google/gemma-3-1b-it-qat-q4_0-gguf/resolve/main/gemma-3-1b-it-qat-q4_0.gguf',
    fileName: 'gemma-3-1b-it-qat-q4_0.gguf',
    sizeBytes: 1_050_000_000,
    minRamBytes: 3_000_000_000,
    stop: ['<end_of_turn>'],
  },
];

export const DEFAULT_BRAIN_ID = 'qwen25-0.5b-q4km';

export function getBrain(id: string): BrainModel {
  return BRAIN_MODELS.find((m) => m.id === id) ?? BRAIN_MODELS[0];
}
