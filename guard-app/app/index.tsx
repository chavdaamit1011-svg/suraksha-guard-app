import { Redirect } from 'expo-router';
import { KEYS, store } from '@/lib/storage';
import { useEffect, useState } from 'react';
import { useAuth } from '@/store/auth';

/** Routing gate. Decides the first screen from persisted state. */
export default function Index() {
  const hydrated = useAuth((s) => s.hydrated);
  const guard = useAuth((s) => s.guard);
  const needsPin = useAuth((s) => s.needsPin);
  const [langChosen, setLangChosen] = useState<boolean | null>(null);

  useEffect(() => {
    store.getJSON<string>(KEYS.language, '').then((l) => setLangChosen(!!l));
  }, []);

  if (!hydrated || langChosen === null) return null;
  if (!langChosen) return <Redirect href="/language" />;
  if (!guard) return <Redirect href="/login" />;
  if (needsPin) return <Redirect href="/pin?mode=enter" />;
  return <Redirect href="/home" />;
}
