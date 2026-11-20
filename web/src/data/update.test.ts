// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkForUpdate,
  readIgnoredVersion,
  readLastUpdateCheck,
  writeIgnoredVersion,
  writeLastUpdateCheck,
} from './update';

beforeEach(() => {
  localStorage.clear();
});

describe('更新源瀑布流降级与检查编排', () => {
  it('主镜像超时失败后自动切换到 fastly.jsdelivr 节点并返回新版清单', async () => {
    const requested: string[] = [];
    const manifestJson = JSON.stringify({
      version: '1.3.0',
      versionCode: 1030099,
      releasedAt: '2026-11-22',
      notes: ['支持镜像热切换'],
      apkUrl: 'https://github.com/Yuvzol0932/Mdlego/releases/download/v1.3.0/app-debug.apk',
    });

    const result = await checkForUpdate('1.2.4-rc.1', {
      now: () => 1_700_000_000_123,
      fetcher: async (url) => {
        requested.push(url);
        if (url.includes('gh-proxy.com')) return null;
        if (url.includes('fastly.jsdelivr.net')) return { status: 200, body: manifestJson };
        return { status: 500, body: '' };
      },
    });

    expect(requested).toHaveLength(2);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.manifest.version).toBe('1.3.0');
      expect(result.manifest.source).toBe('jsdelivr');
    }
    expect(readLastUpdateCheck()).toBe(1_700_000_000_123);
  });

  it('3 个 latest.json 节点全部 404 时自动兜底到 GitHub API 并生成镜像下载列表', async () => {
    const githubRelease = JSON.stringify({
      draft: false,
      prerelease: false,
      tag_name: 'v1.2.4',
      published_at: '2026-11-21T10:00:00Z',
      html_url: 'https://github.com/Yuvzol0932/Mdlego/releases/tag/v1.2.4',
      body: '- 新增中文左右游标手柄\n- 新增应用内更新检查',
      assets: [
        {
          name: 'mdlego-1.2.4-android.apk',
          browser_download_url: 'https://github.com/Yuvzol0932/Mdlego/releases/download/v1.2.4/mdlego-1.2.4-android.apk',
        },
      ],
    });

    const result = await checkForUpdate('1.2.3', {
      fetcher: async (url) => {
        if (url.includes('api.github.com')) return { status: 200, body: githubRelease };
        return { status: 404, body: '' };
      },
    });

    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.manifest.version).toBe('1.2.4');
      expect(result.manifest.source).toBe('github-api');
      expect(result.manifest.downloads).toHaveLength(3);
      expect(result.manifest.downloads[0]?.url).toContain('https://gh-proxy.com/');
    }
  });

  it('所有更新源均不可达或返回坏 JSON 时平滑返回 error，不抛出异常', async () => {
    const result = await checkForUpdate('1.2.3', {
      fetcher: async (url) => {
        if (url.includes('gh-proxy.com')) return { status: 200, body: '<html>bad</html>' };
        return null;
      },
    });
    expect(result).toEqual({
      status: 'error',
      message: '暂时无法连接更新源，请检查网络后重试',
    });
    expect(readLastUpdateCheck()).toBeNull();
  });

  it('localStorage 检查时间与忽略版本号能正常往返读写', () => {
    expect(readLastUpdateCheck()).toBeNull();
    expect(readIgnoredVersion()).toBeNull();

    writeLastUpdateCheck(1_700_123_456_789);
    writeIgnoredVersion('v1.2.5');
    expect(readLastUpdateCheck()).toBe(1_700_123_456_789);
    expect(readIgnoredVersion()).toBe('1.2.5');
  });
});
