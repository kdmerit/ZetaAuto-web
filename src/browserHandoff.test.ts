import { afterEach, describe, expect, it, vi } from 'vitest';

const base = 'https://api.example.com/dev';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function fixture(owner = 'owner-one') {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const verifier = Array.from(raw, value => value.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const session = { accessToken:'test-access-value-for-browser', email:'kdmerit@gmail.com', expiresAt:Date.now()+900000, apiBaseUrl:base };
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv}, key, new TextEncoder().encode(JSON.stringify(session))));
  const combined = new Uint8Array(12+encrypted.length); combined.set(iv); combined.set(encrypted,12);
  const href = `https://kdmerit.github.io/ZetaAuto-web/#app_grant=${'a'.repeat(64)}&key=${verifier}`;
  const replace = vi.fn();
  vi.stubGlobal('window',{location:{href},history:{state:{},replaceState:replace},setTimeout,clearTimeout});
  const fetcher = vi.fn().mockImplementation(async (_url:string, _init:RequestInit) => {
    expect(replace).toHaveBeenCalled();
    return new Response(JSON.stringify(_url.endsWith('/consume')
      ? {ciphertext:btoa(String.fromCharCode(...combined)),ownerId:owner}
      : {userId:'owner-one'}),{status:200});
  });
  vi.stubGlobal('fetch',fetcher);
  return {session,replace,fetcher};
}

describe('Chrome app login handoff',()=>{
  it('decrypts a native-compatible IV+ciphertext+tag and redeems once under StrictMode',async()=>{
    const {session,replace,fetcher}=await fixture();
    const {takeBrowserHandoff}=await import('./browserHandoff');
    const first=takeBrowserHandoff(base),second=takeBrowserHandoff(base);
    expect(first).toBe(second);
    await expect(first).resolves.toEqual(session);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(replace.mock.calls[0]?.[2]).toBe('https://kdmerit.github.io/ZetaAuto-web/');
    expect(fetcher.mock.calls[0]?.[1]?.body).not.toContain(session.accessToken);
  });
  it('requires the same authenticated server owner as the grant creator',async()=>{
    await fixture('another-owner');
    const {takeBrowserHandoff}=await import('./browserHandoff');
    await expect(takeBrowserHandoff(base)).rejects.toThrow('계정을 확인');
  });
});
