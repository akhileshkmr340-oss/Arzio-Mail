// Small key/value store: the phone's secure keychain, or localStorage on the web.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const web = Platform.OS === 'web';
const k = (key: string) => `arzio.${key}`;

export const storage = {
  get: async (key: string): Promise<string | null> => (web ? globalThis.localStorage?.getItem(k(key)) ?? null : SecureStore.getItemAsync(k(key))),
  set: async (key: string, value: string) => { if (web) globalThis.localStorage?.setItem(k(key), value); else await SecureStore.setItemAsync(k(key), value); },
  remove: async (key: string) => { if (web) globalThis.localStorage?.removeItem(k(key)); else await SecureStore.deleteItemAsync(k(key)); },
};
