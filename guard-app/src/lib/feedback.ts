import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';

/**
 * "Done" you can feel and hear without reading the screen (PRD 18.17.1 rule 10): a two-note
 * chime plus the success haptic, used for every completed duty action.
 */

const CHIME = require('../../assets/success.wav');
let player: AudioPlayer | null = null;

export function successFeedback(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  try {
    if (!player) player = createAudioPlayer(CHIME);
    player.volume = 0.8;
    player.seekTo(0).catch(() => {});
    player.play();
  } catch {
    /* no audio output — the haptic still carries it */
  }
}
