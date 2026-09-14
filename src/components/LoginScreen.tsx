import { Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import {
  apiKey,
  apiKeyLoading,
  apiKeyError,
  submitApiKey,
  closeApiKeyDialog,
  removeApiKey,
} from "../lib/stores/auth";
import { platformOpenUrl } from "../lib/platform";
import "./LoginScreen.css";

const AISTUDIO_KEY_URL = "https://aistudio.google.com/app/apikey";

export default function LoginScreen() {
  const [inputValue, setInputValue] = createSignal(apiKey() ?? "");

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    await submitApiKey(inputValue());
  };

  const handleSkip = () => {
    closeApiKeyDialog();
  };

  const handleGetKey = (e: Event) => {
    e.preventDefault();
    platformOpenUrl(AISTUDIO_KEY_URL);
  };

  return (
    <div class="login-screen">
      {/* Liquid Glass ambient orbs — decorative only */}
      <div class="ios-orb ios-orb-a" aria-hidden="true" />
      <div class="ios-orb ios-orb-b" aria-hidden="true" />

      <div class="login-card">
        <div class="login-logo">
          <div class="login-icon lumi-logo" />
        </div>
        <h1 class="login-title">Lumi AI</h1>
        <p class="login-subtitle">
          Enter your Gemini API key to get started
        </p>

        <Show when={apiKeyError()}>
          <div class="login-error" role="alert">
            {apiKeyError()}
          </div>
        </Show>

        <form class="api-key-form" onSubmit={handleSubmit}>
          <div class="api-key-input-wrapper">
            <input
              ref={(el) => { if (!el.disabled) el.focus(); }}
              type="password"
              class="api-key-input"
              placeholder="AIza..."
              value={inputValue()}
              onInput={(e) => setInputValue(e.currentTarget.value)}
              autocomplete="off"
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              enterkeyhint="done"
              aria-label="Gemini API key"
              aria-invalid={!!apiKeyError()}
              autofocus
              disabled={apiKeyLoading()}
            />
          </div>

          <p class="login-disclaimer api-key-hint">
            Get your free API key from{" "}
            <a href={AISTUDIO_KEY_URL} class="login-link" onClick={handleGetKey}>
              Google AI Studio
            </a>
          </p>

          <div class="api-key-actions">
            <button
              type="submit"
              disabled={apiKeyLoading() || !inputValue().trim()}
              class="ios-primary-btn login-button"
            >
              <Show
                when={!apiKeyLoading()}
                fallback={<span class="ios-spinner" aria-hidden="true" />}
              >
                Save API Key
              </Show>
            </button>

            <button
              type="button"
              class="login-text-btn"
              onClick={handleSkip}
              disabled={apiKeyLoading()}
            >
              Skip for now
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Dialog for reconfiguring the API key after initial setup.
 * iOS 26: bottom sheet on mobile (slide-up + grabber),
 * centered sheet on desktop. Backdrop uses system blur.
 * Logic (submitApiKey / close / remove) unchanged.
 */
export function ApiKeyDialog() {
  const [inputValue, setInputValue] = createSignal(apiKey() ?? "");

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    await submitApiKey(inputValue());
  };

  const handleCancel = () => {
    closeApiKeyDialog();
  };

  const handleRemoveKey = async () => {
    setInputValue("");
    await removeApiKey();
  };

  const handleGetKey = (e: Event) => {
    e.preventDefault();
    platformOpenUrl(AISTUDIO_KEY_URL);
  };

  return (
    <Portal>
      <div class="apikey-dialog-backdrop" onClick={handleCancel}>
        <div
          class="apikey-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="API Key Settings"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="apikey-grabber" aria-hidden="true" />
          <h2 class="apikey-dialog-title">API Key Settings</h2>
          <p class="apikey-dialog-subtitle">
            Update your Gemini API key
          </p>

          <Show when={apiKeyError()}>
            <div class="login-error apikey-dialog-error" role="alert">
              {apiKeyError()}
            </div>
          </Show>

          <form class="api-key-form" onSubmit={handleSubmit}>
            <div class="api-key-input-wrapper">
              <input
                type="password"
                class="api-key-input"
                placeholder="AIza..."
                value={inputValue()}
                onInput={(e) => setInputValue(e.currentTarget.value)}
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                enterkeyhint="done"
                aria-label="Gemini API key"
                disabled={apiKeyLoading()}
              />
            </div>

            <p class="login-disclaimer api-key-hint">
              Get your free API key from{" "}
              <a href={AISTUDIO_KEY_URL} class="login-link" onClick={handleGetKey}>
                Google AI Studio
              </a>
            </p>

            <div class="api-key-actions">
              <button
                type="submit"
                disabled={apiKeyLoading() || !inputValue().trim()}
                class="ios-primary-btn login-button"
              >
                <Show
                  when={!apiKeyLoading()}
                  fallback={<span class="ios-spinner" aria-hidden="true" />}
                >
                  Save API Key
                </Show>
              </button>

              <button
                type="button"
                class="login-text-btn login-text-btn-primary apikey-dialog-cancel"
                onClick={handleCancel}
                disabled={apiKeyLoading()}
              >
                Cancel
              </button>
            </div>
          </form>

          <button
            type="button"
            class="login-text-btn login-text-btn-danger apikey-dialog-remove"
            onClick={handleRemoveKey}
            disabled={apiKeyLoading()}
          >
            Remove API key
          </button>
        </div>
      </div>
    </Portal>
  );
}
