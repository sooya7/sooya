import { describe, expect, it } from 'vitest';
import type { ChatProvider, ChatRequest } from '../src/providers/types.js';
import { DirectorClient } from '../src/core/director/client.js';
import { MediaDirector } from '../src/core/mediaDirector.js';

function directorWith(reply: string, requests: ChatRequest[] = []): MediaDirector {
  const provider: ChatProvider = {
    name: 'fake',
    configured: true,
    async complete(request) {
      requests.push(request);
      return { text: reply, usage: undefined };
    },
    async stream(_request, _onChunk) {
      return { text: reply, usage: undefined };
    },
    async inspectHealth() {
      return { capability: 'chat', configured: true, ok: true, provider: 'fake', checkedAt: new Date().toISOString() };
    }
  };
  return new MediaDirector(new DirectorClient(() => provider));
}

describe('MediaDirector image continuity protocol', () => {
  it('passes continuity as data and returns a canonical outfit', async () => {
    const requests: ChatRequest[] = [];
    const director = directorWith(JSON.stringify({
      prompt: 'A natural phone selfie beside the library window with realistic light.',
      aspectRatio: '3:4',
      outfit: '黑色轻便休闲外套、浅色内搭、深色长裤和白色休闲鞋'
    }), requests);

    const result = await director.image({ scene: '图书馆窗边自拍', intent: 'selfie' }, {
      continuity: {
        dateKey: '2026-08-22',
        currentActivity: '在图书馆看小说',
        currentLocation: '市图书馆',
        previousOutfit: '黑色轻便休闲外套、浅色内搭、深色长裤和白色休闲鞋',
        outfitMode: 'locked',
        changeReason: null
      }
    });

    expect(result.outfit).toBe('黑色轻便休闲外套、浅色内搭、深色长裤和白色休闲鞋');
    const input = requests[0]!.messages[0]!.content[0];
    expect(input.type).toBe('text');
    expect(input.type === 'text' ? input.text : '').toContain('"outfitMode": "locked"');
    expect(input.type === 'text' ? input.text : '').toContain('在图书馆看小说');
  });

  it('keeps the previous outfit in the fallback when the director returns invalid output', async () => {
    const previousOutfit = '黑色外套、白色上衣、深色长裤和白色休闲鞋';
    const director = directorWith('not valid director json');
    const result = await director.image({ scene: '咖啡店自拍', action: '喝咖啡' }, {
      continuity: {
        currentActivity: '喝咖啡',
        currentLocation: '街角咖啡店',
        previousOutfit,
        outfitMode: 'locked'
      }
    });

    expect(result.outfit).toBe(previousOutfit);
    expect(result.prompt).toContain(previousOutfit);
    expect(result.prompt).toContain('Keep every garment, color, material, and layer exactly unchanged');
    expect(result.prompt).toContain('Real current activity: 喝咖啡');
    expect(result.prompt).toContain('Real current location: 街角咖啡店');
  });
});
