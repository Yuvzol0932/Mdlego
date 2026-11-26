/**
 * 词典显示整形单测（lookup #7）。
 *
 * 用例里的音标原文都是从真实词库 `www/dict/*.tsv.gz` 里捞出来的
 * （统计口径：`ә` 16623 条、`æ` 10028 条、`ə` 5499 条……），
 * 所以这些断言直接对应线上会看到的字符，不是编造的例子。
 */

import { describe, expect, it } from 'vitest';
import {
  formLine,
  normalizePhonetic,
  normalizePunctuation,
  parseTranslation,
} from './dict-format';

describe('normalizePhonetic：非标准字符 → 标准 IPA', () => {
  it('ASCII 撇号换成主重音符号，音标后的冒号换成 IPA 长音符号 ː', () => {
    expect(normalizePhonetic("'prɒspekt")).toBe('ˈprɒspekt');
    expect(normalizePhonetic("'bju:tiful")).toBe('ˈbjuːtiful');
    expect(normalizePhonetic("sә'pɔ:tiŋ")).toBe('səˈpɔːtiŋ');
  });

  it('修复 ECDICT 遗留字库损坏符号（^ → ɡ、\\\\: → ɜː、aj → aʊ、әj → əʊ、点/逗号次重音 → ˌ）', () => {
    expect(normalizePhonetic("æ'blætә^rɑ:f")).toBe('æˈblætəɡrɑːf');
    expect(normalizePhonetic("әbajt't\\\\\\\\:n")).toBe('əbaʊtˈtɜːn');
    expect(normalizePhonetic("'ei'rәjd")).toBe('ˈeiˈrəʊd');
    expect(normalizePhonetic("'ɑ:ftәj\\\\\\\\:z")).toBe('ˈɑːftəjɜːz');
    expect(normalizePhonetic(".ju:ni'vә:siti")).toBe('ˌjuːniˈvɜːsiti');
    expect(normalizePhonetic(",eibi:'si:")).toBe('ˌeibiːˈsiː');
    expect(normalizePhonetic(",eihis'tɔrik,-kəl")).toBe('ˌeihisˈtɔrik,-kəl');
  });

  it('西里尔 schwa ә(U+04D9) 换成拉丁 ə(U+0259)', () => {
    // 'betә（better）/ fi'nɒminәn（phenomenon）都是词库里的真实写法
    expect(normalizePhonetic("'betә")).toBe('ˈbetə');
    expect(normalizePhonetic("fi'nɒminәn")).toBe('fiˈnɒminən');
  });

  it('希腊 epsilon ε 与西里尔 є 换成 ɛ', () => {
    expect(normalizePhonetic('ε')).toBe('ɛ');
    expect(normalizePhonetic('є')).toBe('ɛ');
  });

  it('上标尖 ˊ(U+02CA) 换成主重音符号', () => {
    expect(normalizePhonetic('ˊprɒspekt')).toBe('ˈprɒspekt');
  });

  it('ū 展开成 uː', () => {
    expect(normalizePhonetic('ū')).toBe('uː');
  });

  it('本来就是标准 IPA 的字符一个都不动', () => {
    // 这些是最容易被"顺手转错"的：它们看着特殊，但都是标准符号
    const standard = 'ŋ ʃ ʒ θ ð ʌ ʊ ɔ ɑ ɪ ɜ ə ɡ ː ˌ ˈ';
    expect(normalizePhonetic(standard)).toBe(standard);
  });

  it('无法识别的字符原样保留（宁可难看，不许改错）', () => {
    expect(normalizePhonetic('ɵ')).toBe('ɵ');
    expect(normalizePhonetic('ɝ')).toBe('ɝ');
  });

  it('去掉调用方可能已经加的方括号与斜杠，避免双重包裹', () => {
    expect(normalizePhonetic("['prɒspekt]")).toBe('ˈprɒspekt');
    expect(normalizePhonetic('/ˈprɒspekt/')).toBe('ˈprɒspekt');
  });

  it('空音标返回空串（不是一对空方括号）', () => {
    expect(normalizePhonetic('')).toBe('');
    expect(normalizePhonetic('   ')).toBe('');
  });
});

describe('normalizePunctuation：中文标点', () => {
  it('中文旁边的半角逗号换全角', () => {
    expect(normalizePunctuation('景色, 展望')).toBe('景色，展望');
    expect(normalizePunctuation('坚持, 维持, 持续存在')).toBe('坚持，维持，持续存在');
  });

  it('中文旁边的半角分号换全角', () => {
    expect(normalizePunctuation('刺激; 激励; 煽动')).toBe('刺激；激励；煽动');
  });

  it('纯英文内容不动（1,000 与 a, b 不是中文标点）', () => {
    expect(normalizePunctuation('1,000 items')).toBe('1,000 items');
    expect(normalizePunctuation('a, b and c')).toBe('a, b and c');
  });

  it('中英混排时只转中文那一侧', () => {
    expect(normalizePunctuation('坚持不懈 persist, 保持')).toBe('坚持不懈 persist，保持');
  });
});

describe('parseTranslation：词性标签与领域标注', () => {
  it('拆出词性与释义（prospect 的真实词条）', () => {
    const lines = parseTranslation('n. 景色, 展望\nvt. 勘探, 勘察\nvi. 勘探, 有前途');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ pos: 'n.', text: '景色，展望', domain: null });
    expect(lines[1]).toEqual({ pos: 'vt.', text: '勘探，勘察', domain: null });
    expect(lines[2]).toEqual({ pos: 'vi.', text: '勘探，有前途', domain: null });
  });

  it('adv. 不会被 a. 抢先切开', () => {
    const lines = parseTranslation('adv. 比较好');
    expect(lines[0]?.pos).toBe('adv.');
    expect(lines[0]?.text).toBe('比较好');
  });

  it('带领域标注的行单独拆出 domain', () => {
    const lines = parseTranslation('n. 现象, 迹象\n[化] 现象');
    expect(lines[0]?.pos).toBe('n.');
    expect(lines[1]).toEqual({ pos: null, text: '现象', domain: '化' });
  });

  it('没有词性的行也保留（如「go的过去式」）', () => {
    const lines = parseTranslation('go的过去式');
    expect(lines).toEqual([{ pos: null, text: 'go的过去式', domain: null }]);
  });

  it('空行被丢弃', () => {
    expect(parseTranslation('n. 景色\n\n\nvt. 勘探')).toHaveLength(2);
  });
});

describe('formLine：词形行', () => {
  it('查到原形 → 显示「原形 · X」', () => {
    expect(formLine('persisted', 'persist')).toBe('原形 · persist');
    expect(formLine('better', 'good')).toBe('原形 · good');
    expect(formLine('went', 'go')).toBe('原形 · go');
  });

  it('没有 lemma 信息 → null（词库不提供变形表，不许编）', () => {
    expect(formLine('prospect', undefined)).toBeNull();
  });

  it('原形与所查词相同 → null（不显示无信息量的行）', () => {
    expect(formLine('Prospect', 'prospect')).toBeNull();
    expect(formLine('prospect', '  ')).toBeNull();
  });
});
