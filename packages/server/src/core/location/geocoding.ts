import type { LocationKind } from '../../db/repos/location.repo.js';

/**
 * Geocoding 抽象（Location 模块）。
 *
 * 约定：
 * - 服务只依赖 `GeocodingProvider` 接口，不绑定任何具体厂商；
 * - 未配置 provider 时优雅降级（search 返回空数组、reverse 返回 null），
 *   绝不抛错、绝不让位置链路因此中断；
 * - 绝不读取用户 GPS / 设备定位 —— reverse 只接受管理端显式提供的坐标。
 */

export interface GeocodingCandidate {
  name: string;
  /** 可选坐标（coarse/exact 皆可，未提供则不写）。 */
  lat?: number;
  lng?: number;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  /** 建议写入 life_locations.tags 的标签。 */
  tags?: string[];
  /** 建议的场所类型。 */
  kind?: LocationKind;
}

export interface GeocodingProvider {
  name: string;
  search(query: string, opts?: { signal?: AbortSignal; limit?: number }): Promise<GeocodingCandidate[]>;
  reverse?(lat: number, lng: number, opts?: { signal?: AbortSignal }): Promise<GeocodingCandidate | null>;
}

/** 无 provider 时的空实现：调用方无需判空。 */
export const NO_GEOCODER: GeocodingProvider = {
  name: 'none',
  search: async () => []
};

/** 是否真的配置了可用的 provider（name !== 'none' 视为已配置）。 */
export function isGeocodingConfigured(provider: GeocodingProvider | undefined): boolean {
  return !!provider && provider.name !== 'none';
}
