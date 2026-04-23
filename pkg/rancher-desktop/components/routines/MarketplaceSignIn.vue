<template>
  <div class="mp-signin">
    <div class="panel">
      <div class="eyebrow">
        Sulla Cloud
      </div>
      <h2>{{ mode === 'login' ? 'Sign in to the marketplace' : 'Create your marketplace account' }}</h2>
      <p class="dek">
        You need a free Sulla Cloud account to install routines, skills, functions, and recipes
        from the marketplace — and to publish your own.
      </p>

      <form
        class="form"
        @submit.prevent="submit"
      >
        <label
          v-if="mode === 'register'"
          class="field"
        >
          <span class="label">Name <span class="optional">(optional)</span></span>
          <input
            v-model="name"
            type="text"
            autocomplete="name"
            :disabled="loading"
            placeholder="Jane Doe"
          >
        </label>

        <label class="field">
          <span class="label">Email</span>
          <input
            v-model="email"
            type="email"
            autocomplete="email"
            required
            :disabled="loading"
            placeholder="you@example.com"
          >
        </label>

        <label class="field">
          <span class="label">
            Password
            <span
              v-if="mode === 'register'"
              class="optional"
            >(8+ characters)</span>
          </span>
          <input
            v-model="password"
            type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            required
            :disabled="loading"
            :minlength="mode === 'register' ? 8 : undefined"
            placeholder="••••••••"
          >
        </label>

        <div
          v-if="error"
          class="banner err"
        >
          {{ error }}
        </div>

        <button
          type="submit"
          class="btn primary"
          :disabled="loading || !email || !password"
        >
          {{ submitLabel }}
        </button>

        <div class="toggle">
          <template v-if="mode === 'login'">
            New to Sulla Cloud?
            <button
              type="button"
              class="link"
              :disabled="loading"
              @click="setMode('register')"
            >
              Register
            </button>
          </template>
          <template v-else>
            Already have an account?
            <button
              type="button"
              class="link"
              :disabled="loading"
              @click="setMode('login')"
            >
              Log in
            </button>
          </template>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const emit = defineEmits<(e: 'signed-in') => void>();

type Mode = 'login' | 'register';

const mode = ref<Mode>('login');
const email = ref('');
const password = ref('');
const name = ref('');
const loading = ref(false);
const error = ref<string | null>(null);

const submitLabel = computed(() => {
  if (loading.value) return mode.value === 'login' ? 'Signing in…' : 'Creating account…';
  return mode.value === 'login' ? 'Sign in' : 'Create account';
});

function setMode(next: Mode) {
  mode.value = next;
  error.value = null;
}

async function submit() {
  const e = email.value.trim().toLowerCase();
  const p = password.value;
  const n = name.value.trim();
  if (!e || !p) {
    error.value = 'Email and password are required.';
    return;
  }
  if (mode.value === 'register' && p.length < 8) {
    error.value = 'Password must be at least 8 characters.';
    return;
  }

  loading.value = true;
  error.value = null;
  try {
    const channel = mode.value === 'login'
      ? 'sulla-cloud:email-login'
      : 'sulla-cloud:email-register';
    const args = mode.value === 'login'
      ? [e, p]
      : [e, p, n || undefined];
    const result = await ipcRenderer.invoke(channel as any, ...args) as {
      ok: boolean; error?: string;
    };
    if (!result?.ok) {
      error.value = result?.error ?? 'Sign-in failed. Try again.';
      return;
    }
    password.value = '';
    emit('signed-in');
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.mp-signin {
  flex: 1;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 48px 32px;
  overflow-y: auto;
}

.panel {
  width: 100%;
  max-width: 420px;
  background: rgba(20, 30, 54, 0.45);
  border: 1px solid rgba(140, 172, 201, 0.22);
  border-radius: 10px;
  padding: 28px 32px 24px;
  backdrop-filter: blur(6px);
  box-shadow: 0 18px 40px rgba(3, 8, 18, 0.45);
}

.eyebrow {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  letter-spacing: 0.24em;
  color: #8cacc9;
  text-transform: uppercase;
  margin-bottom: 10px;
}

h2 {
  font-family: var(--font-display, serif);
  font-size: 24px;
  line-height: 1.2;
  color: white;
  margin: 0 0 10px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.dek {
  font-size: 13.5px;
  line-height: 1.5;
  color: #c4d4e6;
  margin: 0 0 22px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field .label {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #a8c0dc;
  display: flex;
  align-items: center;
  gap: 8px;
}

.field .optional {
  text-transform: none;
  letter-spacing: 0;
  font-size: 11px;
  color: #6b87a4;
  font-family: inherit;
}

.field input {
  padding: 10px 12px;
  background: rgba(6, 12, 24, 0.75);
  border: 1px solid rgba(140, 172, 201, 0.3);
  border-radius: 5px;
  color: white;
  font-size: 14px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
}

.field input::placeholder {
  color: #5a7694;
}

.field input:focus {
  border-color: rgba(196, 212, 230, 0.65);
  background: rgba(20, 30, 54, 0.8);
}

.field input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.banner.err {
  padding: 10px 12px;
  border-radius: 5px;
  background: rgba(127, 29, 29, 0.4);
  border: 1px solid rgba(248, 113, 113, 0.5);
  color: #fecaca;
  font-size: 13px;
  line-height: 1.4;
}

.btn {
  padding: 11px 16px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  border-radius: 5px;
  border: 1px solid rgba(140, 172, 201, 0.45);
  background: transparent;
  color: white;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s;
}

.btn.primary {
  background: linear-gradient(135deg, #4a6fa5, #2c4871);
  border-color: rgba(140, 172, 201, 0.6);
  box-shadow: 0 6px 18px rgba(74, 111, 165, 0.35);
}

.btn.primary:hover:not(:disabled) {
  background: linear-gradient(135deg, #5a82b9, #375785);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toggle {
  margin-top: 4px;
  font-size: 13px;
  color: #a8c0dc;
  text-align: center;
}

.link {
  background: transparent;
  border: none;
  padding: 0;
  color: #80b4e8;
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.link:hover:not(:disabled) {
  color: #b3d4f5;
}

.link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
