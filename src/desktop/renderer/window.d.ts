import type { DesktopApi } from '../api';

declare global {
  interface Window {
    marketMaker: DesktopApi;
  }
}
