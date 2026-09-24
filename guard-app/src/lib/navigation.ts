import { router } from 'expo-router';

/**
 * Safely navigates back if there is a previous route in the navigator stack.
 * If the stack is empty (e.g. user reloaded the page, followed a deep link, or visited directly),
 * it navigates to the fallback route (defaults to '/home') without throwing an unhandled navigation warning.
 */
export function goBack(fallback: string = '/home') {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace(fallback as any);
  }
}
