/**
 * The training catalogue (PRD 18.14 Training, SUR-GAP-024).
 *
 * Reference data rather than database rows, so a wording fix ships without a release or a
 * migration. Agencies author their own site-specific modules in §20; this is the baseline set
 * every guard gets.
 *
 * Shape follows the PRD's constraints on the audience, not a generic LMS:
 *  - lessons are ≤ 3 minutes and written to be **listened to**, because a large share of guards
 *    read slowly (18.0 literacy assumption). Each lesson is short prose the app reads aloud.
 *  - quiz questions are **picture-based** — each option carries an icon, so a guard who cannot
 *    read the option text can still answer from the icon and the spoken prompt.
 *  - pass mark is 70% by default (18.14), and failing simply means trying again.
 *
 * Text is carried per-language with English as the fallback, matching the notice fallback chain
 * in 18.2 §9(c): guard language → agency default → English.
 */

export type Localised = { en: string; hi?: string };

export type Lesson = {
  id: string;
  title: Localised;
  /** Read aloud in the guard's language. Kept short — one idea per lesson. */
  body: Localised;
  seconds: number;
  icon: string;
};

export type QuizOption = {
  id: string;
  label: Localised;
  icon: string;
};

export type QuizQuestion = {
  id: string;
  prompt: Localised;
  options: QuizOption[];
  correctOptionId: string;
};

export type TrainingModule = {
  id: string;
  title: Localised;
  summary: Localised;
  minutes: number;
  mandatory: boolean;
  /** Post types this module gates. An armed post needs the weapons module, and so on. */
  gatesPostTypes: string[];
  /** Months until the completion lapses and must be retaken. Null means it does not expire. */
  validityMonths: number | null;
  passMarkPct: number;
  icon: string;
  lessons: Lesson[];
  quiz: QuizQuestion[];
};

export const TRAINING_CATALOGUE: TrainingModule[] = [
  {
    id: 'induction',
    title: { en: 'Guard induction', hi: 'गार्ड परिचय' },
    summary: {
      en: 'What is expected of you on every shift.',
      hi: 'हर शिफ़्ट में आपसे क्या अपेक्षित है।',
    },
    minutes: 8,
    mandatory: true,
    gatesPostTypes: [],
    validityMonths: 24,
    passMarkPct: 70,
    icon: 'shield-checkmark',
    lessons: [
      {
        id: 'induction-1',
        title: { en: 'Reporting for duty', hi: 'ड्यूटी पर पहुँचना' },
        body: {
          en: 'Reach your post fifteen minutes before your shift starts. Check in on the app as soon as you arrive, at the gate, not on the way. Take the handover from the guard you are relieving: anything unusual on their shift, any visitor still inside, any equipment that is not working. Never leave your post until your relief has arrived and you have handed over to them.',
          hi: 'शिफ़्ट शुरू होने से पंद्रह मिनट पहले अपनी पोस्ट पर पहुँचें। पहुँचते ही ऐप में चेक-इन करें — गेट पर, रास्ते में नहीं। जिस गार्ड की जगह आ रहे हैं उससे हैंडओवर लें: उनकी शिफ़्ट में कुछ असामान्य, कोई विज़िटर अभी अंदर, कोई उपकरण खराब। अपनी रिलीफ़ आने और उन्हें हैंडओवर देने तक पोस्ट न छोड़ें।',
        },
        seconds: 90,
        icon: 'log-in',
      },
      {
        id: 'induction-2',
        title: { en: 'Uniform and equipment', hi: 'वर्दी और उपकरण' },
        body: {
          en: 'Wear the full uniform your site requires, with your identity card visible. Carry what the post orders list: usually a torch, a whistle, and the visitor register. Check your torch works before the night shift, not during it. If any equipment is missing or broken, report it at check-in so it is on record and not blamed on you later.',
          hi: 'अपनी साइट की पूरी वर्दी पहनें, पहचान पत्र दिखता रहे। पोस्ट ऑर्डर में जो लिखा है वो साथ रखें: आमतौर पर टॉर्च, सीटी, और विज़िटर रजिस्टर। रात की शिफ़्ट से पहले टॉर्च जाँच लें, शिफ़्ट के दौरान नहीं। कोई उपकरण गायब या खराब हो तो चेक-इन पर बताएं ताकि रिकॉर्ड में आए और बाद में आप पर दोष न आए।',
        },
        seconds: 80,
        icon: 'shirt',
      },
      {
        id: 'induction-3',
        title: { en: 'Gate discipline', hi: 'गेट अनुशासन' },
        body: {
          en: 'The gate is never left unattended. Do not sit with your back to the entrance. Do not use your phone for anything except duty. Stop every vehicle and every person you do not recognise, politely, and check before you open. If someone refuses to be checked, do not argue and do not force it — call your supervisor.',
          hi: 'गेट कभी खाली न छोड़ें। प्रवेश की ओर पीठ करके न बैठें। ड्यूटी के अलावा फ़ोन का उपयोग न करें। हर वाहन और हर अनजान व्यक्ति को विनम्रता से रोकें, खोलने से पहले जाँचें। कोई जाँच से मना करे तो बहस न करें, ज़बरदस्ती न करें — सुपरवाइज़र को कॉल करें।',
        },
        seconds: 85,
        icon: 'enter',
      },
    ],
    quiz: [
      {
        id: 'ind-q1',
        prompt: { en: 'When should you check in on the app?', hi: 'ऐप में चेक-इन कब करना चाहिए?' },
        options: [
          { id: 'a', label: { en: 'At the gate when you arrive', hi: 'पहुँचते ही गेट पर' }, icon: 'location' },
          { id: 'b', label: { en: 'On the way to the site', hi: 'साइट के रास्ते में' }, icon: 'bus' },
          { id: 'c', label: { en: 'At the end of the shift', hi: 'शिफ़्ट के अंत में' }, icon: 'moon' },
        ],
        correctOptionId: 'a',
      },
      {
        id: 'ind-q2',
        prompt: { en: 'When can you leave your post?', hi: 'आप अपनी पोस्ट कब छोड़ सकते हैं?' },
        options: [
          { id: 'a', label: { en: 'When your relief has arrived', hi: 'जब आपकी रिलीफ़ आ जाए' }, icon: 'people' },
          { id: 'b', label: { en: 'When the shift time is over', hi: 'जब शिफ़्ट का समय खत्म हो' }, icon: 'time' },
          { id: 'c', label: { en: 'Whenever it is quiet', hi: 'जब भी शांति हो' }, icon: 'cafe' },
        ],
        correctOptionId: 'a',
      },
      {
        id: 'ind-q3',
        prompt: {
          en: 'Someone refuses to let you check them. What do you do?',
          hi: 'कोई जाँच कराने से मना करता है। आप क्या करेंगे?',
        },
        options: [
          { id: 'a', label: { en: 'Call your supervisor', hi: 'सुपरवाइज़र को कॉल करें' }, icon: 'call' },
          { id: 'b', label: { en: 'Stop them physically', hi: 'शारीरिक रूप से रोकें' }, icon: 'hand-left' },
          { id: 'c', label: { en: 'Let them through', hi: 'जाने दें' }, icon: 'walk' },
        ],
        correctOptionId: 'a',
      },
    ],
  },

  {
    id: 'fire',
    title: { en: 'Fire safety', hi: 'आग से सुरक्षा' },
    summary: { en: 'Spotting, reporting and first response.', hi: 'पहचानना, बताना और पहली प्रतिक्रिया।' },
    minutes: 6,
    mandatory: true,
    gatesPostTypes: [],
    validityMonths: 12,
    passMarkPct: 70,
    icon: 'flame',
    lessons: [
      {
        id: 'fire-1',
        title: { en: 'Spotting a fire risk', hi: 'आग का खतरा पहचानना' },
        body: {
          en: 'Most fires are visible as a risk long before they start. Watch for overloaded power boards, cables running under carpets, rubbish piled near a generator, blocked fire exits, and extinguishers that are missing or past their service date. Report these as an incident. A risk you reported is a fire that did not happen.',
          hi: 'ज़्यादातर आग शुरू होने से बहुत पहले खतरे के रूप में दिखती है। ध्यान दें: ओवरलोड पावर बोर्ड, कालीन के नीचे तार, जनरेटर के पास कचरा, बंद फ़ायर एग्ज़िट, और गायब या एक्सपायर अग्निशामक। इन्हें घटना के रूप में दर्ज करें। जो खतरा आपने बताया, वो आग है जो लगी ही नहीं।',
        },
        seconds: 80,
        icon: 'warning',
      },
      {
        id: 'fire-2',
        title: { en: 'Raising the alarm', hi: 'अलार्म बजाना' },
        body: {
          en: 'If you see fire, raise the alarm first. People before property, always. Sound the site alarm, call the fire brigade on one zero one, then tell your supervisor and the control room. Do not spend time deciding whether it is serious enough. A false alarm costs nothing. A late alarm costs lives.',
          hi: 'आग दिखे तो पहले अलार्म बजाएं। हमेशा संपत्ति से पहले लोग। साइट का अलार्म बजाएं, एक शून्य एक पर फ़ायर ब्रिगेड को कॉल करें, फिर सुपरवाइज़र और कंट्रोल रूम को बताएं। यह तय करने में समय न लगाएं कि गंभीर है या नहीं। झूठे अलार्म की कोई कीमत नहीं। देर से बजे अलार्म की कीमत जान है।',
        },
        seconds: 75,
        icon: 'megaphone',
      },
      {
        id: 'fire-3',
        title: { en: 'Using an extinguisher', hi: 'अग्निशामक का उपयोग' },
        body: {
          en: 'Only fight a fire that is small and between you and a clear way out. Pull the pin, aim at the base of the flames, squeeze the handle, sweep side to side. Never turn your back on a fire. If it does not go out in a few seconds, leave. Never use water on an electrical fire.',
          hi: 'सिर्फ़ छोटी आग से लड़ें, और तब जब आग और आपके बीच बाहर निकलने का रास्ता साफ़ हो। पिन खींचें, लपटों के आधार पर निशाना लगाएं, हैंडल दबाएं, अगल-बगल घुमाएं। आग की ओर कभी पीठ न करें। कुछ सेकंड में न बुझे तो निकल जाएं। बिजली की आग पर कभी पानी न डालें।',
        },
        seconds: 85,
        icon: 'flame',
      },
    ],
    quiz: [
      {
        id: 'fire-q1',
        prompt: { en: 'You see a fire. What comes first?', hi: 'आपको आग दिखी। सबसे पहले क्या?' },
        options: [
          { id: 'a', label: { en: 'Raise the alarm', hi: 'अलार्म बजाएं' }, icon: 'megaphone' },
          { id: 'b', label: { en: 'Try to put it out', hi: 'बुझाने की कोशिश करें' }, icon: 'flame' },
          { id: 'c', label: { en: 'Move the property', hi: 'सामान हटाएं' }, icon: 'cube' },
        ],
        correctOptionId: 'a',
      },
      {
        id: 'fire-q2',
        prompt: { en: 'Where do you aim an extinguisher?', hi: 'अग्निशामक कहाँ निशाना लगाएं?' },
        options: [
          { id: 'a', label: { en: 'At the base of the flames', hi: 'लपटों के आधार पर' }, icon: 'arrow-down' },
          { id: 'b', label: { en: 'At the top of the flames', hi: 'लपटों के ऊपर' }, icon: 'arrow-up' },
          { id: 'c', label: { en: 'At the smoke', hi: 'धुएँ पर' }, icon: 'cloud' },
        ],
        correctOptionId: 'a',
      },
      {
        id: 'fire-q3',
        prompt: { en: 'An electrical fire. Use water?', hi: 'बिजली की आग। पानी डालें?' },
        options: [
          { id: 'a', label: { en: 'Never', hi: 'कभी नहीं' }, icon: 'close-circle' },
          { id: 'b', label: { en: 'Yes, plenty of it', hi: 'हाँ, खूब सारा' }, icon: 'water' },
          { id: 'c', label: { en: 'Only a little', hi: 'सिर्फ़ थोड़ा' }, icon: 'rainy' },
        ],
        correctOptionId: 'a',
      },
      {
        id: 'fire-q4',
        prompt: { en: 'Who is evacuated first?', hi: 'पहले किसे निकाला जाता है?' },
        options: [
          { id: 'a', label: { en: 'People', hi: 'लोग' }, icon: 'people' },
          { id: 'b', label: { en: 'Valuables', hi: 'कीमती सामान' }, icon: 'diamond' },
          { id: 'c', label: { en: 'Vehicles', hi: 'वाहन' }, icon: 'car' },
        ],
        correctOptionId: 'a',
      },
    ],
  },

  {
    id: 'emergency',
    title: { en: 'Emergency and SOS', hi: 'आपातकाल और SOS' },
    summary: { en: 'When to raise SOS, and what happens next.', hi: 'SOS कब दबाएं, और फिर क्या होता है।' },
    minutes: 7,
    mandatory: true,
    gatesPostTypes: [],
    validityMonths: 12,
    passMarkPct: 70,
    icon: 'alert-circle',
    lessons: [
      {
        id: 'emg-1',
        title: { en: 'When to raise SOS', hi: 'SOS कब दबाएं' },
        body: {
          en: 'Raise SOS when there is a threat to life or serious injury: an assault, a robbery in progress, a fire, a medical emergency, or when you feel you are in danger. Do not wait to be certain. You will never be blamed for an SOS that turned out to be nothing. You may be the only person who can call for help.',
          hi: 'जान का खतरा या गंभीर चोट हो तो SOS दबाएं: हमला, चल रही डकैती, आग, मेडिकल इमरजेंसी, या जब आपको खतरा महसूस हो। पक्का होने का इंतज़ार न करें। जो SOS बाद में कुछ नहीं निकला, उसके लिए आपको कभी दोष नहीं मिलेगा। हो सकता है मदद बुलाने वाले सिर्फ़ आप ही हों।',
        },
        seconds: 80,
        icon: 'warning',
      },
      {
        id: 'emg-2',
        title: { en: 'How to raise it', hi: 'कैसे दबाएं' },
        body: {
          en: 'Press and hold the red SOS button for two seconds, from any screen in the app. It works without network: the phone sounds a siren, flashes the torch, and keeps trying to reach the control room and your supervisor by every route it has. Do not run to find signal. Raise it where you are.',
          hi: 'ऐप की किसी भी स्क्रीन से लाल SOS बटन दो सेकंड दबाए रखें। यह बिना नेटवर्क भी काम करता है: फ़ोन सायरन बजाता है, टॉर्च चमकाता है, और कंट्रोल रूम व सुपरवाइज़र तक हर रास्ते से पहुँचने की कोशिश करता रहता है। सिग्नल ढूँढने के लिए न भागें। जहाँ हैं वहीं दबाएं।',
        },
        seconds: 75,
        icon: 'radio',
      },
      {
        id: 'emg-3',
        title: { en: 'After you raise it', hi: 'दबाने के बाद' },
        body: {
          en: 'Get yourself to safety first. The screen shows who has picked up your alarm and their name once they do. Only cancel with your PIN, and only if you are genuinely safe — the PIN is there so nobody who takes your phone can call off your alarm.',
          hi: 'पहले खुद को सुरक्षित करें। स्क्रीन दिखाएगी कि आपका अलार्म किसने उठाया और उनका नाम। रद्द सिर्फ़ अपने PIN से करें, और तभी जब आप सच में सुरक्षित हों — PIN इसलिए है ताकि आपका फ़ोन छीनने वाला अलार्म बंद न कर सके।',
        },
        seconds: 70,
        icon: 'shield-checkmark',
      },
    ],
    quiz: [
      {
        id: 'emg-q1',
        prompt: { en: 'How do you raise SOS?', hi: 'SOS कैसे दबाते हैं?' },
        options: [
          { id: 'a', label: { en: 'Hold the red button 2 seconds', hi: 'लाल बटन 2 सेकंड दबाए रखें' }, icon: 'radio-button-on' },
          { id: 'b', label: { en: 'Tap it once', hi: 'एक बार टैप करें' }, icon: 'finger-print' },
          { id: 'c', label: { en: 'Shake the phone', hi: 'फ़ोन हिलाएं' }, icon: 'phone-portrait' },
        ],
        correctOptionId: 'a',
      },
      {
        id: 'emg-q2',
        prompt: { en: 'No network. Does SOS work?', hi: 'नेटवर्क नहीं। क्या SOS चलेगा?' },
        options: [
          { id: 'a', label: { en: 'Yes, it still works', hi: 'हाँ, फिर भी चलता है' }, icon: 'checkmark-circle' },
          { id: 'b', label: { en: 'No, find signal first', hi: 'नहीं, पहले सिग्नल ढूँढें' }, icon: 'close-circle' },
          { id: 'c', label: { en: 'Only if charging', hi: 'सिर्फ़ चार्ज करते समय' }, icon: 'battery-charging' },
        ],
        correctOptionId: 'a',
      },
      {
        id: 'emg-q3',
        prompt: { en: 'What is needed to cancel an SOS?', hi: 'SOS रद्द करने के लिए क्या चाहिए?' },
        options: [
          { id: 'a', label: { en: 'Your PIN', hi: 'आपका PIN' }, icon: 'lock-closed' },
          { id: 'b', label: { en: 'Nothing', hi: 'कुछ नहीं' }, icon: 'close' },
          { id: 'c', label: { en: "Supervisor's permission", hi: 'सुपरवाइज़र की अनुमति' }, icon: 'person' },
        ],
        correctOptionId: 'a',
      },
    ],
  },

  {
    id: 'visitor',
    title: { en: 'Visitor management', hi: 'विज़िटर प्रबंधन' },
    summary: { en: 'Checking, logging and handling deliveries.', hi: 'जाँच, दर्ज करना और डिलीवरी संभालना।' },
    minutes: 5,
    mandatory: false,
    gatesPostTypes: ['Gate Guard'],
    validityMonths: null,
    passMarkPct: 70,
    icon: 'people',
    lessons: [
      {
        id: 'vis-1',
        title: { en: 'Verifying identity', hi: 'पहचान जाँचना' },
        body: {
          en: 'Ask who they are visiting and confirm with that person before letting anyone in. Look at the photo on the identity card and then at the face in front of you. Write down the card number, do not keep the card. If the story changes when you ask again, that is worth reporting.',
          hi: 'पूछें किससे मिलने आए हैं और अंदर जाने देने से पहले उस व्यक्ति से पुष्टि करें। पहचान पत्र की फ़ोटो देखें, फिर सामने वाले चेहरे को। कार्ड नंबर लिख लें, कार्ड अपने पास न रखें। दोबारा पूछने पर कहानी बदले तो यह बताने लायक बात है।',
        },
        seconds: 75,
        icon: 'card',
      },
      {
        id: 'vis-2',
        title: { en: 'Logging entry and exit', hi: 'आना-जाना दर्ज करना' },
        body: {
          en: 'Every visitor is written down when they come in and again when they leave. An entry with no exit at the end of your shift is something you hand over, not something you ignore. The register is the record that protects both the client and you.',
          hi: 'हर विज़िटर आते समय और जाते समय दर्ज होता है। शिफ़्ट के अंत में जिसकी एंट्री है पर एग्ज़िट नहीं, वो हैंडओवर में बताने की बात है, नज़रअंदाज़ करने की नहीं। रजिस्टर वो रिकॉर्ड है जो क्लाइंट और आप दोनों की रक्षा करता है।',
        },
        seconds: 70,
        icon: 'book',
      },
      {
        id: 'vis-3',
        title: { en: 'Handling deliveries', hi: 'डिलीवरी संभालना' },
        body: {
          en: 'Deliveries stop at the gate unless the resident has said otherwise. Note the company, the vehicle number and the name. Do not sign for anything valuable on someone else\'s behalf. Never let a delivery person wander the site alone to find an address.',
          hi: 'डिलीवरी गेट पर रुकेगी, जब तक निवासी ने कुछ और न कहा हो। कंपनी, वाहन नंबर और नाम नोट करें। किसी और की ओर से कीमती सामान के लिए हस्ताक्षर न करें। डिलीवरी वाले को पता ढूँढने के लिए अकेले साइट में घूमने न दें।',
        },
        seconds: 70,
        icon: 'cube',
      },
    ],
    quiz: [
      {
        id: 'vis-q1',
        prompt: { en: 'Before letting a visitor in, you should:', hi: 'विज़िटर को अंदर जाने देने से पहले:' },
        options: [
          { id: 'a', label: { en: 'Confirm with the person they name', hi: 'जिसका नाम लिया उससे पुष्टि करें' }, icon: 'call' },
          { id: 'b', label: { en: 'Just check the ID card', hi: 'सिर्फ़ ID कार्ड देखें' }, icon: 'card' },
          { id: 'c', label: { en: 'Let them in if polite', hi: 'विनम्र हों तो जाने दें' }, icon: 'happy' },
        ],
        correctOptionId: 'a',
      },
      {
        id: 'vis-q2',
        prompt: { en: 'A visitor entry with no exit at shift end:', hi: 'शिफ़्ट के अंत में एंट्री है, एग्ज़िट नहीं:' },
        options: [
          { id: 'a', label: { en: 'Hand it over to the next guard', hi: 'अगले गार्ड को हैंडओवर करें' }, icon: 'swap-horizontal' },
          { id: 'b', label: { en: 'Mark them as left', hi: 'निकला हुआ मार्क कर दें' }, icon: 'create' },
          { id: 'c', label: { en: 'Ignore it', hi: 'नज़रअंदाज़ करें' }, icon: 'eye-off' },
        ],
        correctOptionId: 'a',
      },
      {
        id: 'vis-q3',
        prompt: { en: 'Should you keep a visitor\'s ID card?', hi: 'क्या विज़िटर का ID कार्ड रखना चाहिए?' },
        options: [
          { id: 'a', label: { en: 'No, note the number only', hi: 'नहीं, सिर्फ़ नंबर नोट करें' }, icon: 'create' },
          { id: 'b', label: { en: 'Yes, until they leave', hi: 'हाँ, जाने तक' }, icon: 'card' },
          { id: 'c', label: { en: 'Yes, keep a photocopy', hi: 'हाँ, फ़ोटोकॉपी रखें' }, icon: 'copy' },
        ],
        correctOptionId: 'a',
      },
    ],
  },
];

/** Pick a localised string with the PRD 18.2 §9(c) fallback chain: guard language → English. */
export function pick(value: Localised | undefined, lang: string): string {
  if (!value) return '';
  return (value as any)[lang] ?? value.en ?? '';
}

export function findModule(moduleId: string): TrainingModule | undefined {
  return TRAINING_CATALOGUE.find((m) => m.id === moduleId);
}

/** The catalogue version, bumped by hand when content changes so devices know to re-download. */
export const CATALOGUE_VERSION = 2;
