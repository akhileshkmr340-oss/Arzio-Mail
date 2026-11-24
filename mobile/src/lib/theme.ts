import { useColorScheme } from 'react-native';

const light = {
  brand: '#0f6cbd', brandDark: '#0c5a9e', brandLight: '#ebf3fc', bg: '#f5f5f5', panel: '#ffffff', text: '#242424',
  muted: '#616161', line: '#e0e0e0', danger: '#c50f1f', ai: '#7a3fd1', aiLight: '#f4effc', unreadDot: '#0f6cbd',
};
const dark: typeof light = {
  brand: '#479ef5', brandDark: '#2886de', brandLight: '#1b2a3a', bg: '#141414', panel: '#1f1f1f', text: '#f0f0f0',
  muted: '#adadad', line: '#333333', danger: '#f1707b', ai: '#b48ef0', aiLight: '#2a2238', unreadDot: '#479ef5',
};
export type Theme = typeof light;
export function useTheme(): Theme { return useColorScheme() === 'dark' ? dark : light; }
