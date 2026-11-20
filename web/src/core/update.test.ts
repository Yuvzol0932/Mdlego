import { describe, expect, it } from 'vitest';
import {
  AUTO_CHECK_INTERVAL_MS,
  UPDATE_SOURCES,
  buildMirrorDownloads,
  compareForUpdate,
  isSafeHttpsUrl,
  normalizeVersion,
  parseGitHubReleaseJson,
  parseManifestJson,
  parseVersionCode,
  shouldAutoCheck,
} from './update';

describe('版本规范化与 versionCode 换算', () => {
  it('normalizeVersion 去除空白与前导 v/V', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion(' V1.2.4-rc.2 ')).toBe('1.2.4-rc.2');
    expect(normalizeVersion('1.0.0')).toBe('1.0.0');
  });

  it('parseVersionCode 与 Android Gradle 推导完全一致', () => {
    expect(parseVersionCode('1.2.3')).toBe(1020399);
    expect(parseVersionCode('v1.2.4-rc.1')).toBe(1020451);
    expect(parseVersionCode('1.2.4-rc.2')).toBe(1020452);
    expect(parseVersionCode('1.2.4')).toBe(1020499);
    expect(parseVersionCode('bad')).toBeNull();
    expect(parseVersionCode('1.2')).toBeNull();
  });

  it('RC 与正式版比较：高版本 RC 不误报降级，正式版高于同号 RC', () => {
    const release123 = parseManifestJson(
      {
        version: '1.2.3',
        versionCode: 1020399,
        apkUrl: 'https://github.com/Yuvzol0932/Mdlego/releases/download/v1.2.3/app-debug.apk',
      },
      'gh-proxy',
    );
    expect(release123).not.toBeNull();
    expect(compareForUpdate('1.2.4-rc.1', release123!).status).toBe('latest');
    expect(compareForUpdate('1.2.2', release123!).status).toBe('available');

    const release124 = parseManifestJson(
      {
        version: '1.2.4',
        apkUrl: 'https://github.com/Yuvzol0932/Mdlego/releases/download/v1.2.4/app-debug.apk',
      },
      'gh-proxy',
    );
    expect(release124).not.toBeNull();
    expect(compareForUpdate('1.2.4-rc.1', release124!).status).toBe('available');
  });
});

describe('URL 安全校验与镜像线路构造', () => {
  it('拦截非 https、控制字符与危险协议', () => {
    expect(isSafeHttpsUrl('https://gh-proxy.com/app.apk')).toBe(true);
    expect(isSafeHttpsUrl('http://gh-proxy.com/app.apk')).toBe(false);
    expect(isSafeHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpsUrl('intent://foo')).toBe(false);
    expect(isSafeHttpsUrl('https://example.com/a b.apk')).toBe(false);
    expect(isSafeHttpsUrl('')).toBe(false);
  });

  it('buildMirrorDownloads 构造 2 条国内镜像 + 1 条官方直连', () => {
    const list = buildMirrorDownloads('https://github.com/Yuvzol0932/Mdlego/releases/download/v1.2.3/app-debug.apk');
    expect(list).toHaveLength(3);
    expect(list[0]?.url).toBe(
      'https://gh-proxy.com/https://github.com/Yuvzol0932/Mdlego/releases/download/v1.2.3/app-debug.apk',
    );
    expect(list[1]?.url).toBe(
      'https://ghfast.top/https://github.com/Yuvzol0932/Mdlego/releases/download/v1.2.3/app-debug.apk',
    );
    expect(list[2]?.url).toBe(
      'https://github.com/Yuvzol0932/Mdlego/releases/download/v1.2.3/app-debug.apk',
    );
  });

  it('UPDATE_SOURCES 按 gh-proxy → fastly.jsdelivr → ghfast → github-api 顺序排列', () => {
    expect(UPDATE_SOURCES.map((s) => s.name)).toEqual(['gh-proxy', 'jsdelivr', 'ghfast', 'github-api']);
  });
});

describe('清单与 GitHub Release 解析', () => {
  it('parseManifestJson 清洗不安全下载项与超长更新说明', () => {
    const longNote = '更新'.repeat(120);
    const parsed = parseManifestJson(
      {
        version: 'v1.2.4',
        releasedAt: '2026-11-21T12:00:00',
        notes: [longNote, '', 42, '第二条说明'],
        downloads: [
          { label: '恶意协议', url: 'javascript:alert(1)' },
          { label: 'HTTP 明文', url: 'http://example.com/app.apk' },
          { label: '有效国内镜像', hint: '高速', url: 'https://gh-proxy.com/ok.apk' },
        ],
        releasePageUrl: 'javascript:void(0)',
      },
      'jsdelivr',
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe('1.2.4');
    expect(parsed?.versionCode).toBe(1020499);
    expect(parsed?.notes).toHaveLength(2);
    expect(parsed?.notes[0]).toHaveLength(160);
    expect(parsed?.downloads).toEqual([{ label: '有效国内镜像', hint: '高速', url: 'https://gh-proxy.com/ok.apk' }]);
    expect(parsed?.releasePageUrl).toBe('https://github.com/Yuvzol0932/Mdlego/releases/tag/v1.2.4');
  });

  it('无有效下载链接且无有效发布页时返回 null', () => {
    expect(parseManifestJson({ version: '1.2.4', downloads: [{ label: 'bad', url: 'http://x' }] }, 'src')).toBeNull();
  });

  it('parseGitHubReleaseJson 拒绝 draft 与 prerelease，正常版本提取 APK 并清理 Markdown', () => {
    expect(parseGitHubReleaseJson({ draft: true, prerelease: false, tag_name: 'v1.3.0' }, 'github-api')).toBeNull();
    expect(parseGitHubReleaseJson({ draft: false, prerelease: true, tag_name: 'v1.3.0-rc.1' }, 'github-api')).toBeNull();

    const rel = parseGitHubReleaseJson(
      {
        draft: false,
        prerelease: false,
        tag_name: 'v1.2.4',
        published_at: '2026-11-21T08:00:00Z',
        html_url: 'https://github.com/Yuvzol0932/Mdlego/releases/tag/v1.2.4',
        body: '## 更新内容\n- **新增** 中文游标手柄\n- 查看 [发布说明](https://example.com)\n',
        assets: [
          { name: 'checksum.txt', browser_download_url: 'https://github.com/a/checksum.txt' },
          { name: 'mdlego-1.2.4-android.apk', browser_download_url: 'https://github.com/Yuvzol0932/Mdlego/releases/download/v1.2.4/mdlego-1.2.4-android.apk' },
        ],
      },
      'github-api',
    );
    expect(rel).not.toBeNull();
    expect(rel?.version).toBe('1.2.4');
    expect(rel?.releasedAt).toBe('2026-11-21');
    expect(rel?.notes).toEqual(['新增 中文游标手柄', '查看 发布说明']);
    expect(rel?.downloads).toHaveLength(3);
    expect(rel?.downloads[0]?.url).toContain('https://gh-proxy.com/');
  });
});

describe('自动检查节流', () => {
  it('未检查过或超过 24 小时才允许自动检查', () => {
    const now = 1_700_000_000_000;
    expect(shouldAutoCheck(null, now)).toBe(true);
    expect(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS + 1000, now)).toBe(false);
    expect(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS, now)).toBe(true);
    expect(shouldAutoCheck(now + 10_000, now)).toBe(true);
  });
});
