import type { Address } from 'viem';

import type { WalletProfile } from '../api';
import { inlineImage } from './inlineImage';

/**
 * The wallet's GONDI name and picture for the header, the picture inlined. A picture that cannot
 * be inlined is left out rather than failing the profile, so the name still shows.
 */
export const walletProfile = async (
  api: { profile(wallet: Address): Promise<{ name: string | null; pictureUrl: string | null }> },
  wallet: Address,
  download: typeof fetch = fetch,
): Promise<WalletProfile> => {
  const { name, pictureUrl } = await api.profile(wallet);
  const picture = pictureUrl ? await inlineImage(pictureUrl, download).catch(() => null) : null;
  return { name, picture };
};
