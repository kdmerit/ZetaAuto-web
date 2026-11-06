import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StrategyBacktest } from './StrategyBacktest';

describe('reference workspace', () => {
  it('provides the MA10 entry filter for the reference strategy', () => {
    const html = renderToStaticMarkup(<StrategyBacktest strategy="REFERENCE" context={{ apiBaseUrl: 'https://example.invalid', accessToken: 'fixture-only' }} />);
    expect(html).toContain('기준봉 MA10 위치 조건');
    expect(html).toContain('저가&lt;MA10');
    expect(html).toContain('>1H<');
    expect(html).toContain('>4H<');
    expect(html).toContain('>1D<');
  });
});
