#!/usr/bin/env python3
"""接话判断器的 LoRA 微调脚本（可选，进阶用户用）。

前置：
  1. 桥接以 agent 模式跑一段时间，积累 state/judge-decisions.jsonl
  2. 导出训练集：node scripts/export-judge-dataset.mjs
  3. 装依赖：pip install torch transformers peft datasets accelerate

用法：
  python scripts/train-judge-lora.py --data dataset/judge-train.jsonl --out dataset/judge-lora
  显存不足时加 --load-4bit（需要 bitsandbytes）。

训练完成后（两选一）：
  A. 直接推理：把 adapter 合进底座，用 transformers 部署（本项目暂不支持，需要额外适配）
  B. 转 GGUF 给 llama.cpp 用（推荐）：
     1) python -m transformers.models... 或官方脚本合并 LoRA：
        python -c "from peft import PeftModel; from transformers import AutoModelForCausalLM; ..."
     2) 克隆 llama.cpp，用 convert_hf_to_gguf.py 转 FP16，再 quantize 成 Q4_K_M：
        python llama.cpp/convert_hf_to_gguf.py merged/ --outfile judge-f16.gguf
        llama.cpp/build/bin/llama-quantize judge-f16.gguf judge-Q4_K_M.gguf Q4_K_M
     3) 把 gguf 放进 models/，启动桥接即可（自动优先使用）

注意：0.6B 模型 + 少量样本的效果有限；建议至少几百条、正负均衡的人工确认样本。
"""
import argparse
import json
import os
import sys

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--data', default='dataset/judge-train.jsonl')
    p.add_argument('--out', default='dataset/judge-lora')
    p.add_argument('--base', default='Qwen/Qwen3-0.6B')
    p.add_argument('--epochs', type=float, default=3)
    p.add_argument('--lr', type=float, default=1e-4)
    p.add_argument('--batch', type=int, default=4)
    p.add_argument('--max-len', type=int, default=512)
    p.add_argument('--load-4bit', action='store_true')
    return p.parse_args()


def load_rows(path, tokenizer, max_len):
    rows = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            obj = json.loads(line)
            messages = obj.get('messages') or []
            if len(messages) < 3:
                continue
            text = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=False, enable_thinking=False,
            )
            enc = tokenizer(text, truncation=True, max_length=max_len, padding=False)
            enc['labels'] = list(enc['input_ids'])
            rows.append(enc)
    return rows


def main():
    args = parse_args()
    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig, get_peft_model
        from transformers import (AutoModelForCausalLM, AutoTokenizer, DataCollatorForSeq2Seq,
                                  Trainer, TrainingArguments)
    except ImportError as e:
        print(f'缺少依赖：{e.name}。请先 pip install torch transformers peft datasets accelerate', file=sys.stderr)
        return 1

    if not os.path.exists(args.data):
        print(f'找不到训练集 {args.data}；先运行 node scripts/export-judge-dataset.mjs', file=sys.stderr)
        return 1

    tokenizer = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model_kwargs = {'trust_remote_code': True, 'torch_dtype': torch.float16}
    if args.load_4bit:
        from transformers import BitsAndBytesConfig
        model_kwargs['quantization_config'] = BitsAndBytesConfig(load_in_4bit=True)
        model_kwargs['device_map'] = 'auto'
    model = AutoModelForCausalLM.from_pretrained(args.base, **model_kwargs)

    lora = LoraConfig(
        r=16, lora_alpha=32, lora_dropout=0.05, bias='none',
        target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
        task_type='CAUSAL_LM',
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    rows = load_rows(args.data, tokenizer, args.max_len)
    print(f'样本数：{len(rows)}')
    if len(rows) < 50:
        print('样本太少（<50），训练意义有限；建议先积累数据。', file=sys.stderr)

    ds = Dataset.from_list(rows)
    collator = DataCollatorForSeq2Seq(tokenizer, padding=True, label_pad_token_id=-100)
    training_args = TrainingArguments(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=2,
        logging_steps=10,
        save_strategy='epoch',
        fp16=not args.load_4bit,
        report_to=[],
        remove_unused_columns=False,
    )
    trainer = Trainer(model=model, args=training_args, train_dataset=ds, data_collator=collator)
    trainer.train()
    model.save_pretrained(args.out)
    tokenizer.save_pretrained(args.out)
    print(f'LoRA 已保存到 {args.out}')
    print('后续：合并 adapter → 转 GGUF → 放进 models/（见脚本头部说明）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
