<template>
  <div class="th-pane" :class="{ dark: isDark }">
    <div class="th-content">
      <!-- Step 0: Select Documents -->
      <template v-if="currentStep === 0">
        <h2 class="th-title">Select Your Training Data</h2>
        <p class="th-desc">
          Browse your file system and select the folders and files that contain your personal knowledge,
          writing, configs, and expertise. Sulla will auto-scan for supported document types.
        </p>

        <div class="th-section">
          <h3 class="th-subtitle">Supported File Types</h3>
          <div class="th-chips">
            <span class="th-chip">.txt</span>
            <span class="th-chip">.md</span>
            <span class="th-chip">.pdf</span>
            <span class="th-chip">.docx</span>
            <span class="th-chip">.yaml</span>
          </div>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">Tips for Best Results</h3>
          <ul class="th-list">
            <li>Select folders with your personal writing, notes, or documentation</li>
            <li>Include config files to teach the model your environment preferences</li>
            <li>Diverse content produces a more well-rounded model</li>
            <li>You can always come back and add more documents later</li>
          </ul>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">What Happens Next</h3>
          <p class="th-text">
            In the next step you'll craft a prompt that controls how your documents
            are converted into training examples — Q&A pairs, conversational style, or custom formats.
          </p>
        </div>

        <!-- Data quality meter -->
        <div class="th-meter" :class="{ dark: isDark }">
          <h3 class="th-subtitle">Data Quality Estimate</h3>
          <p class="th-text" style="margin-bottom: 10px;">
            Based on the total size of your selected files, this meter estimates
            how much material your model will have to learn from.
          </p>
          <div class="th-meter-header">
            <span class="th-meter-size">{{ formattedSize }} selected</span>
            <span class="th-meter-badge" :class="contentScale.scale">{{ contentScale.label }}</span>
          </div>
          <div class="th-meter-track" :class="{ dark: isDark }">
            <div class="th-meter-fill" :class="contentScale.scale" :style="{ width: contentScale.pct + '%' }" />
          </div>
          <div class="th-meter-labels">
            <span>Poor</span>
            <span>Fair</span>
            <span>Good</span>
            <span>Excellent</span>
          </div>
          <ul class="th-list" style="margin-top: 10px;">
            <li><strong>&lt; 50 KB</strong> — Not enough material for meaningful training</li>
            <li><strong>50–500 KB</strong> — Basic personalization, picks up key patterns</li>
            <li><strong>500 KB – 5 MB</strong> — Strong results, consistent style and knowledge</li>
            <li><strong>&gt; 5 MB</strong> — Excellent, production-quality fine-tune</li>
          </ul>
        </div>
      </template>

      <!-- Step 1: Craft Prompt -->
      <template v-else-if="currentStep === 1">
        <h2 class="th-title">Craft Your Prompt</h2>
        <p class="th-desc">
          The prompt template controls how an LLM transforms your documents into training data.
          A well-crafted prompt produces higher-quality examples.
        </p>

        <div class="th-section">
          <h3 class="th-subtitle">How Prompts Work</h3>
          <p class="th-text">
            When your documents are processed, each chunk of text is sent to an LLM along with your prompt.
            The LLM generates questions or conversation starters based on the content, and the original
            chunk becomes the answer. This creates training pairs your model can learn from.
          </p>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">Template Variables</h3>
          <ul class="th-list">
            <li><code>{document}</code> — replaced with the document chunk text</li>
            <li><code>{filename}</code> — replaced with the source file name</li>
          </ul>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">Tips</h3>
          <ul class="th-list">
            <li>Be specific about the format you want (Q&A, conversation, instruction-following)</li>
            <li>Ask for multiple questions per chunk to maximize training data</li>
            <li>Include style guidance if you want a particular tone</li>
          </ul>
        </div>
      </template>

      <!-- Step 2: Generate Data -->
      <template v-else-if="currentStep === 2">
        <h2 class="th-title">How It Works</h2>
        <p class="th-desc">
          An intelligent LLM reads each of your documents chunk by chunk and generates
          training examples based on your prompt template.
        </p>

        <div class="th-section">
          <h3 class="th-subtitle">Step 1: Chunking</h3>
          <p class="th-text">
            Your documents are split into manageable pieces (typically 1-2K tokens each)
            so the LLM can process them thoroughly. Larger documents produce more chunks,
            which means more training examples.
          </p>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">Step 2: Prompt Generation</h3>
          <p class="th-text">
            For each chunk, the LLM uses your prompt template to generate
            questions, conversation starters, or other prompts that someone might ask about that content.
            The quality of your prompt template directly affects the quality of the training data.
          </p>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">Step 3: Pairing</h3>
          <p class="th-text">
            Each generated question is paired with the original document chunk as the answer,
            creating a complete training example. These Q&A pairs teach the model to respond
            with your actual knowledge when asked relevant questions.
          </p>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">Local vs Cloud Models</h3>
          <ul class="th-list">
            <li><strong>Local models</strong> are free but slower — they use your machine's hardware.</li>
            <li><strong>Cloud models</strong> (OpenAI, Anthropic) are faster and often higher quality, but cost per API call.</li>
            <li>For large document sets, cloud models save hours of processing time.</li>
            <li>For sensitive data, local models keep everything on your machine.</li>
          </ul>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">Tips</h3>
          <ul class="th-list">
            <li>More capable models (GPT-4o, Claude Sonnet) produce better questions but cost more</li>
            <li>Start with a small batch to check quality before processing everything</li>
            <li>You can re-run this step with a different model or prompt to compare results</li>
          </ul>
        </div>
      </template>

      <!-- Step 3: Select Data Files -->
      <template v-else-if="currentStep === 3">
        <h2 class="th-title">Select Training Data</h2>
        <p class="th-desc">
          Choose which data files to include in your fine-tuning run. You can mix and match
          files from different sources.
        </p>

        <div class="th-section">
          <h3 class="th-subtitle">Data Sources</h3>
          <ul class="th-list">
            <li><strong>Documents</strong> — Generated from your files using the Create Training Data wizard</li>
            <li><strong>Sessions</strong> — Collected from your chat conversations with Sulla</li>
            <li><strong>Processed</strong> — Pre-processed and formatted training data</li>
          </ul>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">How Much Data Do I Need?</h3>
          <ul class="th-list">
            <li><strong>&lt; 50 examples</strong> — Not enough for meaningful learning</li>
            <li><strong>50-200 examples</strong> — Basic personalization, model picks up key patterns</li>
            <li><strong>200-500 examples</strong> — Good results, consistent style and knowledge</li>
            <li><strong>500+ examples</strong> — Excellent, production-quality fine-tune</li>
          </ul>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">Tips</h3>
          <ul class="th-list">
            <li>More diverse training data produces better generalization</li>
            <li>Select all files unless you have a specific reason to exclude some</li>
            <li>You can always re-train with different file selections</li>
          </ul>
        </div>
      </template>

      <!-- Step 4: Model & Settings -->
      <template v-else-if="currentStep === 4">
        <h2 class="th-title">Model & Training Settings</h2>
        <p class="th-desc">
          Configure the base model and LoRA parameters for your fine-tuning run.
        </p>

        <div class="th-section">
          <h3 class="th-subtitle">What is LoRA?</h3>
          <p class="th-text">
            LoRA (Low-Rank Adaptation) is a technique that lets you customize a model by training
            only a small number of additional parameters, rather than retraining the entire model.
            This is much faster and requires far less memory.
          </p>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">Parameter Guide</h3>
          <ul class="th-list">
            <li><strong>Learning Rate</strong> — How fast the model learns. Too high = unstable, too low = slow. Default 2e-4 works well for most cases.</li>
            <li><strong>Epochs</strong> — How many times the model sees each example. 2-3 is typical. More epochs risk overfitting.</li>
            <li><strong>LoRA Rank</strong> — Controls adapter capacity. Higher rank = more expressive but uses more memory. 16 is a good default.</li>
            <li><strong>Eval Split</strong> — Percentage of data held out for evaluation. 10-20% is standard.</li>
          </ul>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">Choosing a Base Model</h3>
          <ul class="th-list">
            <li>Larger models (9B) are more capable but slower to train</li>
            <li>Smaller models (0.8B-4B) train faster and run on less hardware</li>
            <li>Pick a model you can run on your machine for inference after training</li>
          </ul>
        </div>
      </template>

      <!-- Step 5: Train & Deploy -->
      <template v-else-if="currentStep === 5">
        <h2 class="th-title">Train & Deploy</h2>
        <p class="th-desc">
          Start the LoRA fine-tuning process and deploy your custom model.
        </p>

        <div class="th-section">
          <h3 class="th-subtitle">What Happens During Training</h3>
          <ul class="th-list">
            <li>Training data is loaded and formatted for the base model</li>
            <li>LoRA adapter layers are trained on your data</li>
            <li>The adapter is merged with the base model</li>
            <li>A quantized GGUF model is exported for efficient inference</li>
            <li>The model is hot-loaded and ready to use</li>
          </ul>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">Training Time</h3>
          <p class="th-text">
            Typical training takes 10-60 minutes depending on your hardware, data size, and model size.
            On Apple Silicon Macs, the MLX backend is used for optimal performance.
            On NVIDIA GPUs, CUDA acceleration is used.
          </p>
        </div>

        <div class="th-section">
          <h3 class="th-subtitle">After Training</h3>
          <p class="th-text">
            Your custom model will be automatically loaded and available in the model selector.
            You can test it immediately through the chat interface.
          </p>
        </div>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';

interface ContentScaleData {
  size: number;
  scale: string;
  label: string;
  pct: number;
}

export default defineComponent({
  name: 'TrainingHelpPane',
  props: {
    isDark:       { type: Boolean, default: false },
    currentStep:  { type: Number, default: 0 },
    contentScale: { type: Object as () => ContentScaleData, default: () => ({ size: 0, scale: 'poor', label: 'Not enough', pct: 0 }) },
  },
  setup(props) {
    const formattedSize = computed(() => {
      const bytes = props.contentScale.size;
      if (bytes < 1024) return `${ bytes } B`;
      if (bytes < 1024 * 1024) return `${ (bytes / 1024).toFixed(1) } KB`;
      return `${ (bytes / (1024 * 1024)).toFixed(1) } MB`;
    });

    return { formattedSize };
  },
});
</script>

<style>
.th-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.th-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px 16px;
}
.th-title {
  font-size: 1.125rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0 0 8px 0;
}
.dark .th-title {
  color: #f1f5f9;
}
.th-desc {
  font-size: 0.8125rem;
  line-height: 1.6;
  color: #475569;
  margin: 0 0 20px 0;
}
.dark .th-desc {
  color: #94a3b8;
}
.th-section {
  margin-bottom: 20px;
}
.th-subtitle {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #334155;
  margin: 0 0 6px 0;
}
.dark .th-subtitle {
  color: #e2e8f0;
}
.th-text {
  font-size: 0.75rem;
  line-height: 1.6;
  color: #64748b;
  margin: 0;
}
.dark .th-text {
  color: #94a3b8;
}
.th-list {
  margin: 0;
  padding: 0 0 0 18px;
  font-size: 0.75rem;
  line-height: 1.7;
  color: #64748b;
}
.dark .th-list {
  color: #94a3b8;
}
.th-list li {
  margin-bottom: 4px;
}
.th-list code {
  font-size: 0.6875rem;
  background: #f1f5f9;
  padding: 1px 4px;
  border-radius: 3px;
  color: #334155;
}
.dark .th-list code {
  background: #334155;
  color: #e2e8f0;
}
.th-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.th-chip {
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  background: #f1f5f9;
  color: #64748b;
}
.dark .th-chip {
  background: #334155;
  color: #94a3b8;
}

/* Data quality meter */
.th-meter {
  margin-top: 20px;
  padding: 14px;
  border-radius: 8px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
}
.th-meter.dark {
  background: #1e293b;
  border-color: #334155;
}
.th-meter-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.th-meter-size {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #334155;
}
.dark .th-meter-size {
  color: #e2e8f0;
}
.th-meter-badge {
  font-size: 0.6875rem;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.th-meter-badge.poor { background: #fef2f2; color: #dc2626; }
.dark .th-meter-badge.poor { background: #450a0a; color: #fca5a5; }
.th-meter-badge.fair { background: #fef3c7; color: #d97706; }
.dark .th-meter-badge.fair { background: #78350f; color: #fcd34d; }
.th-meter-badge.good { background: #dbeafe; color: #2563eb; }
.dark .th-meter-badge.good { background: #1e3a5f; color: #93c5fd; }
.th-meter-badge.great { background: #dcfce7; color: #16a34a; }
.dark .th-meter-badge.great { background: #14532d; color: #86efac; }

.th-meter-track {
  height: 8px;
  border-radius: 4px;
  background: #e2e8f0;
  overflow: hidden;
  position: relative;
}
.th-meter-track.dark {
  background: #334155;
}
.th-meter-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
}
.th-meter-fill.poor { background: #ef4444; }
.th-meter-fill.fair { background: #f59e0b; }
.th-meter-fill.good { background: #3b82f6; }
.th-meter-fill.great { background: #22c55e; }

.th-meter-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 0.625rem;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
