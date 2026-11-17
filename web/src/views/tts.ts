/**
 * 系统 TTS 朗读控制器（阶段 E6）。
 *
 * 用 Web Speech API（`speechSynthesis`）：Chrome/Android WebView 会调用系统 TTS 引擎，
 * 不需要联网、不引第三方库。若系统不支持（或没有可用语音），明确提示而不是假装播放。
 *
 * 界面：阅读页底部浮起一个小播放条（玻璃），含 上一段 / 播放-暂停 / 下一段 / 停止 / 速度。
 * 当前块在正文里加高亮 class 并滚到可见位置。
 */

import { estimateSpeechSeconds, type TtsChunk } from '../core/tts';
import { el, icon } from './app';

/** 支持度检查。 */
export function speechSupported(): boolean {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';
}

export interface TtsPlayer {
  readonly el: HTMLElement;
  start(): void;
  destroy(): void;
}

export interface TtsOptions {
  readonly article: HTMLElement;
  readonly chunks: readonly TtsChunk[];
  readonly onToast: (message: string) => void;
  readonly onFinished?: () => void;
}

const RATES = [0.8, 1, 1.2, 1.5];
const HIGHLIGHT_CLASS = 'tts-current';

export function createTtsPlayer(options: TtsOptions): TtsPlayer {
  const { chunks, article } = options;
  let index = 0;
  let rate = 1;
  let playing = false;
  let destroyed = false;
  let utterance: SpeechSynthesisUtterance | null = null;

  const status = el('span', { class: 'tts-bar__status', 'data-testid': 'tts-status' });
  const playBtn = el('button', {
    class: 'icon-btn tts-bar__play',
    type: 'button',
    'data-testid': 'tts-play',
    'aria-label': '播放',
  }, icon('play'));
  const prevBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'tts-prev',
    'aria-label': '上一段',
  }, icon('back'));
  const nextBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'tts-next',
    'aria-label': '下一段',
  }, icon('chevron'));
  const stopBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'tts-stop',
    'aria-label': '停止朗读',
  }, icon('close'));
  const rateBtn = el('button', {
    class: 'tts-bar__rate ui-press',
    type: 'button',
    'data-testid': 'tts-rate',
    text: '1.0×',
  });

  const bar = el(
    'div',
    { class: 'tts-bar glass', 'data-testid': 'tts-bar', role: 'toolbar', 'aria-label': '朗读' },
    prevBtn,
    playBtn,
    nextBtn,
    el('div', { class: 'tts-bar__text' }, status),
    rateBtn,
    stopBtn,
  );

  function clearHighlight(): void {
    for (const node of article.querySelectorAll<HTMLElement>(`.${HIGHLIGHT_CLASS}`)) {
      node.classList.remove(HIGHLIGHT_CLASS);
    }
  }

  function highlight(): void {
    clearHighlight();
    const chunk = chunks[index];
    if (chunk === undefined || chunk.bid.length === 0) return;
    const block = article.querySelector<HTMLElement>(`[data-bid="${CSS.escape(chunk.bid)}"]`);
    if (block === null) return;
    block.classList.add(HIGHLIGHT_CLASS);
    block.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function refresh(): void {
    const chunk = chunks[index];
    const total = chunks.length;
    status.textContent = chunk === undefined
      ? '已读完'
      : `${index + 1}/${total} · 约 ${estimateSpeechSeconds(chunk.text)}s`;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
    playBtn.setAttribute('data-testid', playing ? 'tts-pause' : 'tts-play');
  }

  function speak(): void {
    if (destroyed || !speechSupported()) return;
    const chunk = chunks[index];
    if (chunk === undefined) {
      playing = false;
      refresh();
      options.onFinished?.();
      return;
    }
    highlight();
    utterance = new SpeechSynthesisUtterance(chunk.text);
    utterance.rate = rate;
    utterance.lang = /[\u4e00-\u9fa5]/.test(chunk.text) ? 'zh-CN' : 'en-US';
    utterance.onend = () => {
      if (destroyed) return;
      index += 1;
      if (index >= chunks.length) {
        playing = false;
        clearHighlight();
        refresh();
        options.onFinished?.();
        return;
      }
      speak();
    };
    utterance.onerror = (event) => {
      if (destroyed) return;
      // interrupted/canceled 是用户主动停止，不算错误
      if (event.error === 'interrupted' || event.error === 'canceled') return;
      playing = false;
      clearHighlight();
      refresh();
      options.onToast(`朗读失败：${event.error}`);
    };
    window.speechSynthesis.speak(utterance);
  }

  function play(): void {
    if (playing) return;
    if (!speechSupported()) {
      options.onToast('当前系统不支持朗读');
      return;
    }
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      playing = true;
      refresh();
      return;
    }
    playing = true;
    refresh();
    speak();
  }

  function pause(): void {
    if (!playing) return;
    playing = false;
    window.speechSynthesis.pause();
    refresh();
  }

  function stop(): void {
    playing = false;
    window.speechSynthesis.cancel();
    clearHighlight();
    refresh();
  }

  playBtn.addEventListener('click', () => {
    if (playing) pause();
    else play();
  });
  prevBtn.addEventListener('click', () => {
    index = Math.max(0, index - 1);
    stop();
    if (!playing) play();
  });
  nextBtn.addEventListener('click', () => {
    index = Math.min(chunks.length - 1, index + 1);
    stop();
    play();
  });
  stopBtn.addEventListener('click', () => {
    stop();
    bar.remove();
    options.onFinished?.();
  });
  rateBtn.addEventListener('click', () => {
    const at = RATES.indexOf(rate);
    rate = RATES[(at + 1) % RATES.length] as number;
    rateBtn.textContent = `${rate.toFixed(1)}×`;
    if (playing) {
      // 改速率要重新读当前段
      window.speechSynthesis.cancel();
      speak();
    }
  });

  refresh();
  return {
    el: bar,
    start: play,
    destroy() {
      destroyed = true;
      playing = false;
      window.speechSynthesis.cancel();
      clearHighlight();
      bar.remove();
    },
  };
}
