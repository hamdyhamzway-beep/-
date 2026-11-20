import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function getAiClient(apiVersion: 'v1beta' | 'v1' = 'v1beta') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('مفتاح Gemini API غير متوفر في إعدادات الخادم');
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isModelNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('404') || msg.includes('NOT_FOUND') || msg.includes('not found');
}

function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export async function transcribeEgyptianAudio(base64Audio: string, mimeType: string): Promise<string> {
  const cleanData = base64Audio.includes(',') ? base64Audio.split(',')[1] : base64Audio;
  if (!cleanData || cleanData.length < 32) {
    throw new Error('التسجيل الصوتي فارغ أو قصير جداً');
  }
  const cleanMime = (mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';
  console.info(
    `[VoiceSTT] Starting transcription: rawMime=${mimeType}, cleanMime=${cleanMime}, base64Len=${cleanData.length}`
  );

  const contents = [
    {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: cleanMime,
            data: cleanData,
          },
        },
        {
          text: 'انسخ هذا التسجيل الصوتي باللغة العربية واللهجة المصرية بدقة تامة دون أي إضافات أو شرح. احتفظ بالأرقام والأسماء كما نطقها المتحدث. إذا كان التسجيل صامتاً أو لا يحتوي على كلام واضح أعد نصاً فارغاً.',
        },
      ],
    },
  ];

  // Prioritize fast multimodal gemini-3.1-flash-lite, then dedicated transcribe; keep total budget < 17s (under proxy timeout)
  const attempts: Array<{ version: 'v1beta' | 'v1'; model: string; timeoutMs: number }> = [
    { version: 'v1beta', model: 'gemini-3.1-flash-lite', timeoutMs: 11500 },
    { version: 'v1beta', model: 'gemini-3.5-transcribe', timeoutMs: 5500 },
  ];

  let lastError: unknown;
  for (const attempt of attempts) {
    const startMs = Date.now();
    try {
      const ai = getAiClient(attempt.version);
      const response = await withTimeout(
        ai.models.generateContent({
          model: attempt.model,
          contents,
        }),
        attempt.timeoutMs,
        `VoiceSTT ${attempt.model}`
      );
      const text = (response.text || '').trim();
      console.info(
        `[VoiceSTT] Attempt ${attempt.version}/${attempt.model} succeeded in ${Date.now() - startMs}ms, chars=${text.length}`
      );
      return text;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[VoiceSTT] Attempt ${attempt.version}/${attempt.model} failed in ${Date.now() - startMs}ms: ${msg}`
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error('تعذر نسخ الصوت');
}

export interface InterpretedVoiceCommand {
  intent:
    | 'record_advance'
    | 'edit_advance'
    | 'delete_advance'
    | 'record_coverage'
    | 'edit_coverage'
    | 'delete_coverage'
    | 'record_bonus'
    | 'record_deduction'
    | 'driver_statement'
    | 'absent_drivers'
    | 'school_advances_total'
    | 'top_advance_driver'
    | 'offline_vehicles'
    | 'total_net_salaries'
    | 'monthly_profit'
    | 'unknown';
  requiresConfirmation: boolean;
  isAmbiguous: boolean;
  ambiguityReason: string;
  driverCode: string;
  driverNameQuery: string;
  schoolNameQuery: string;
  replacementDriverQuery: string;
  amount: number;
  oldAmount: number;
  actualReplacementCost: number;
  absentDriverDeduction: number;
  date: string;
  targetDate: string;
  reason: string;
  paymentMethod: string;
  replyArabic: string;
}

function normalizeArabicDigits(input: string): string {
  const arabicNums = '٠١٢٣٤٥٦٧٨٩';
  return input.replace(/[٠-٩]/g, (d) => String(arabicNums.indexOf(d)));
}

function fallbackInterpretEgyptianCommand(
  rawTranscript: string,
  context: {
    todayDate: string;
    driversList: Array<{ id: number; driverCode: string; fullName: string; schoolName: string; busNumber: string }>;
    schoolsList: Array<{ id: number; name: string }>;
  }
): InterpretedVoiceCommand {
  const text = normalizeArabicDigits(rawTranscript).trim();
  const base: InterpretedVoiceCommand = {
    intent: 'unknown',
    requiresConfirmation: false,
    isAmbiguous: false,
    ambiguityReason: '',
    driverCode: '',
    driverNameQuery: '',
    schoolNameQuery: '',
    replacementDriverQuery: '',
    amount: 0,
    oldAmount: 0,
    actualReplacementCost: 0,
    absentDriverDeduction: 0,
    date: context.todayDate,
    targetDate: '',
    reason: 'أمر صوتي من المدير',
    paymentMethod: 'cash',
    replyArabic: 'مفهمتش الأمر بدقة، ممكن توضحلي اسم السائق أو رقمه والمطلوب؟',
  };

  // Match driver by code or name
  const matchedDriver =
    context.driversList.find((d) => new RegExp(`\\b${d.driverCode}\\b`).test(text)) ||
    context.driversList.find((d) => {
      const parts = d.fullName.split(/\s+/).filter((p) => p.length >= 3);
      return text.includes(d.fullName) || (parts.length >= 2 && text.includes(`${parts[0]} ${parts[1]}`));
    }) ||
    context.driversList.find((d) => {
      const first = d.fullName.split(/\s+/)[0];
      return first && first.length >= 3 && text.includes(first);
    });

  const matchedSchool = context.schoolsList.find(
    (s) =>
      text.includes(s.name) ||
      s.name
        .replace(/مدرسة\s*/g, '')
        .split(/\s+/)
        .filter((w) => w.length >= 4)
        .some((w) => text.includes(w))
  );

  // Extract numeric amounts (excluding matched driverCode)
  const nums = (text.match(/\d+(\.\d+)?/g) || []).map(Number);
  const nonCodeNums = matchedDriver
    ? nums.filter((n) => String(n) !== matchedDriver.driverCode)
    : nums;
  const amount = nonCodeNums.length > 0 ? nonCodeNums[nonCodeNums.length - 1] : 0;
  const oldAmount = nonCodeNums.length >= 2 ? nonCodeNums[0] : 0;

  if (matchedDriver) {
    base.driverCode = matchedDriver.driverCode;
    base.driverNameQuery = matchedDriver.fullName;
  }
  if (matchedSchool) {
    base.schoolNameQuery = matchedSchool.name;
  }

  const isEditVerb = /(عدل|تعديل|عدّل|غير|تغيير|غيّر|خلي|خلّي|زود|زوّد|نقص|قلل|ظبط|بدل|حول)/.test(text);
  const isDeleteVerb = /(احذف|حذف|امسح|مسح|الغي|إلغاء|الغاء|شيل)/.test(text);

  if (/(سلف|سلفه|سلفة|اسلف)/.test(text) && isDeleteVerb) {
    base.intent = 'delete_advance';
    base.requiresConfirmation = true;
    base.oldAmount = amount;
    base.amount = amount;
    if (!matchedDriver) {
      base.isAmbiguous = true;
      base.requiresConfirmation = false;
      base.ambiguityReason = 'من فضلك حدد اسم السائق أو كوده لحذف السلفة.';
      base.replyArabic = base.ambiguityReason;
    } else {
      base.replyArabic = `جاهز لحذف سلفة السائق ${matchedDriver.fullName}. راجع البيانات واضغط تأكيد.`;
    }
    return base;
  }

  if (/(سلف|سلفه|سلفة|اسلف)/.test(text) && isEditVerb) {
    base.intent = 'edit_advance';
    base.requiresConfirmation = true;
    base.amount = amount;
    base.oldAmount = oldAmount;
    base.reason = '';
    if (!matchedDriver) {
      base.isAmbiguous = true;
      base.requiresConfirmation = false;
      base.ambiguityReason = 'من فضلك حدد اسم السائق أو كوده لتعديل السلفة.';
      base.replyArabic = base.ambiguityReason;
    } else {
      base.replyArabic = `جاهز لتعديل سلفة السائق ${matchedDriver.fullName}${amount > 0 ? ` إلى ${amount} جنيه` : ''}.`;
    }
    return base;
  }

  if (/(اتغطى|اتغطي|تغطية|تغطيه|غطى)/.test(text) && isDeleteVerb) {
    base.intent = 'delete_coverage';
    base.requiresConfirmation = true;
    if (!matchedDriver) {
      base.isAmbiguous = true;
      base.requiresConfirmation = false;
      base.ambiguityReason = 'من فضلك حدد اسم السائق أو كوده لحذف التغطية.';
      base.replyArabic = base.ambiguityReason;
    } else {
      base.replyArabic = `جاهز لحذف سجل التغطية للسائق ${matchedDriver.fullName}.`;
    }
    return base;
  }

  if (/(اتغطى|اتغطي|تغطية|تغطيه|بديل|غطى)/.test(text) && isEditVerb) {
    base.intent = 'edit_coverage';
    base.requiresConfirmation = true;
    base.amount = amount;
    base.absentDriverDeduction = amount > 0 ? amount : 0;
    base.actualReplacementCost = amount > 0 ? amount : 0;
    base.reason = '';
    if (!matchedDriver) {
      base.isAmbiguous = true;
      base.requiresConfirmation = false;
      base.ambiguityReason = 'من فضلك حدد اسم السائق أو كوده لتعديل التغطية.';
      base.replyArabic = base.ambiguityReason;
    } else {
      base.replyArabic = `جاهز لتعديل تغطية السائق ${matchedDriver.fullName}.`;
    }
    return base;
  }

  if (/(سلف|سلفه|سلفة|اسلف)/.test(text) && !/(اجمالي|إجمالي|اكتر|أكثر|اكثر|كام)/.test(text)) {
    base.intent = 'record_advance';
    base.requiresConfirmation = true;
    base.amount = amount;
    base.reason = 'سلفة بأمر صوتي';
    if (!matchedDriver || amount <= 0) {
      base.isAmbiguous = true;
      base.requiresConfirmation = false;
      base.ambiguityReason = !matchedDriver
        ? 'من فضلك حدد كود السائق أو اسمه عشان أسجل السلفة.'
        : 'من فضلك حدد مبلغ السلفة بالجنيه.';
      base.replyArabic = base.ambiguityReason;
    } else {
      base.replyArabic = `جاهز لتسجيل سلفة ${amount} جنيه للسائق ${matchedDriver.fullName}.`;
    }
    return base;
  }

  if (/(اتغطى|اتغطي|تغطية|تغطيه|بديل|غطى)/.test(text)) {
    base.intent = 'record_coverage';
    base.requiresConfirmation = true;
    base.absentDriverDeduction = amount > 0 ? amount : 350;
    base.actualReplacementCost = amount > 0 ? amount : 350;
    base.reason = 'تغطية غياب بأمر صوتي';
    if (!matchedDriver) {
      base.isAmbiguous = true;
      base.requiresConfirmation = false;
      base.ambiguityReason = 'من فضلك حدد اسم السائق الغائب أو رقمه لتسجيل التغطية.';
      base.replyArabic = base.ambiguityReason;
    } else {
      base.replyArabic = `جاهز لتسجيل تغطية غياب للسائق ${matchedDriver.fullName}.`;
    }
    return base;
  }

  if (/(مكاف|حافز|بونص)/.test(text)) {
    base.intent = 'record_bonus';
    base.requiresConfirmation = true;
    base.amount = amount;
    base.reason = 'مكافأة بأمر صوتي';
    if (!matchedDriver || amount <= 0) {
      base.isAmbiguous = true;
      base.requiresConfirmation = false;
      base.ambiguityReason = 'حدد السائق ومبلغ المكافأة لتسجيلها.';
      base.replyArabic = base.ambiguityReason;
    }
    return base;
  }

  if (/(خصم|جزاء)/.test(text)) {
    base.intent = 'record_deduction';
    base.requiresConfirmation = true;
    base.amount = amount;
    base.reason = 'خصم إداري بأمر صوتي';
    if (!matchedDriver || amount <= 0) {
      base.isAmbiguous = true;
      base.requiresConfirmation = false;
      base.ambiguityReason = 'حدد السائق ومبلغ الخصم لتسجيله.';
      base.replyArabic = base.ambiguityReason;
    }
    return base;
  }

  if (/(كشف حساب|حساب|مرتب السواق|راتب)/.test(text) && matchedDriver) {
    base.intent = 'driver_statement';
    return base;
  }

  if (/(غايب|غائب|غابوا|الغياب)/.test(text)) {
    base.intent = 'absent_drivers';
    return base;
  }

  if (/(اكتر|أكثر|اكثر).*(سلف)/.test(text) || /(أعلى|اعلى).*(سلف)/.test(text)) {
    base.intent = 'top_advance_driver';
    return base;
  }

  if (/(سلف|السلف)/.test(text) && (matchedSchool || /(اجمالي|إجمالي|كام)/.test(text))) {
    base.intent = 'school_advances_total';
    return base;
  }

  if (/(مش متصل|غير متصل|اوفلاين|أوفلاين|باصات|عربيات|gps)/.test(text)) {
    base.intent = 'offline_vehicles';
    return base;
  }

  if (/(مرتبات|المرتبات|رواتب|الرواتب)/.test(text)) {
    base.intent = 'total_net_salaries';
    return base;
  }

  if (/(ربح|ارباح|أرباح|مكسب)/.test(text)) {
    base.intent = 'monthly_profit';
    return base;
  }

  return base;
}

export async function interpretEgyptianCommand(
  transcript: string,
  context: {
    todayDate: string;
    driversList: Array<{ id: number; driverCode: string; fullName: string; schoolName: string; busNumber: string }>;
    schoolsList: Array<{ id: number; name: string }>;
  }
): Promise<InterpretedVoiceCommand> {
  const systemInstruction = `أنت المساعد الذكي لنظام إدارة النقل المدرسي "الوليد ترافيل" (Al-Waleed Travel) وتفهم اللهجة المصرية بطلاقة.
تاريخ اليوم هو: ${context.todayDate}.
قائمة السائقين النشطين المسجلين في قاعدة البيانات:
${JSON.stringify(context.driversList)}
قائمة المدارس المسجلة في قاعدة البيانات:
${JSON.stringify(context.schoolsList)}

حلل أمر المدير وحدد النية (intent) والكيانات بدقة:
1. نوايا مالية تتطلب تأكيداً (requiresConfirmation = true):
   - record_advance: تسجيل سلفة جديدة لسائق (مثل: "ادي السواق رقم 1025 سلفة 500 جنيه"). إذا لم يُذكر المبلغ أو السائق بوضوح اجعل isAmbiguous = true.
   - edit_advance: تعديل سلفة مسجلة سابقاً لسائق (مثل: "عدل سلفة محمد أحمد إلى 400 جنيه"، "خلي سلفة السواق 1025 تبقى 300 بدل 500"، "غير سلفة أحمد"). ضع المبلغ الجديد في amount والمبلغ القديم (إن ذُكر) في oldAmount.
   - delete_advance: حذف أو إلغاء سلفة مسجلة لسائق (مثل: "احذف سلفة محمد أحمد"، "امسح آخر سلفة للسواق 1025").
   - record_coverage: تسجيل تغطية غياب جديدة لسائق (مثل: "السواق رقم 25 اتغطى النهارده بـ 350 جنيه").
   - edit_coverage: تعديل سجل تغطية غياب قائم لسائق (مثل: "عدل تغطية محمد أحمد إلى 400 جنيه"، "خلي تغطية أحمد 250").
   - delete_coverage: حذف أو إلغاء سجل تغطية قائم لسائق (مثل: "احذف تغطية السواق محمد"، "امسح تغطية النهارده للسائق 1025").
   - record_bonus: إضافة مكافأة لسائق.
   - record_deduction: تسجيل خصم آخر لسائق.
2. نوايا استعلامية فورية (requiresConfirmation = false):
   - driver_statement: عرض كشف حساب سائق معين (مثل: "اعرضلي كشف حساب محمد أحمد").
   - absent_drivers: معرفة السائقين الغائبين اليوم (مثل: "مين السواقين اللي غايبين النهارده؟").
   - school_advances_total: إجمالي السلف لمدرسة معينة (مثل: "إجمالي السلف في إشراقة الغد كام؟").
   - top_advance_driver: أكثر سائق حصل على سلف هذا الشهر.
   - offline_vehicles: الباصات غير المتصلة بالإنترنت / GPS.
   - total_net_salaries: إجمالي صافي المرتبات المطلوب دفعها هذا الشهر.
   - monthly_profit: صافي ربح المكتب الشهري.
   - unknown: إذا كان الأمر غير مفهوم أو خارج نطاق النظام.

قواعد صارمة:
- طابق اسم السائق أو رقمه مع القائمة المعطاة وضع driverCode الصحيح.
- في حالات التعديل والحذف (edit_advance, delete_advance, edit_coverage, delete_coverage): يكفي تحديد السائق (isAmbiguous = false إذا تم تحديد السائق)، وإذا ذكر المدير مبلغاً جديداً ضعه في amount، وإذا لم يذكر مبلغاً جديداً ضع 0 ليختار أو يعدل الرقم في شاشة التأكيد.
- التغطية وتكلفة البديل هما نفس البند تماماً بقيمة واحدة موحدة: في record_coverage و edit_coverage ضع نفس قيمة التغطية في absentDriverDeduction و actualReplacementCost و amount دائماً.
- طابق اسم المدرسة مع القائمة المعطاة وضع schoolNameQuery كما هو في القائمة.
- تاريخ "النهارده" أو "اليوم" يعني ${context.todayDate}، وتاريخ "امبارح" يحسب قبل اليوم بيوم واحد.
- إذا ذكر المدير تسجيل سلفة جديدة (record_advance) بدون مبلغ أو بدون تحديد سائق، ضع isAmbiguous = true واكتب سبباً واضحاً بالمصرية في ambiguityReason.
- اكتب replyArabic دائماً باللهجة المصرية الودودة والمهنية.`;

  const config = {
    systemInstruction,
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        intent: { type: Type.STRING },
        requiresConfirmation: { type: Type.BOOLEAN },
        isAmbiguous: { type: Type.BOOLEAN },
        ambiguityReason: { type: Type.STRING },
        driverCode: { type: Type.STRING },
        driverNameQuery: { type: Type.STRING },
        schoolNameQuery: { type: Type.STRING },
        replacementDriverQuery: { type: Type.STRING },
        amount: { type: Type.NUMBER },
        oldAmount: { type: Type.NUMBER },
        actualReplacementCost: { type: Type.NUMBER },
        absentDriverDeduction: { type: Type.NUMBER },
        date: { type: Type.STRING },
        targetDate: { type: Type.STRING },
        reason: { type: Type.STRING },
        paymentMethod: { type: Type.STRING },
        replyArabic: { type: Type.STRING },
      },
      required: [
        'intent',
        'requiresConfirmation',
        'isAmbiguous',
        'ambiguityReason',
        'driverCode',
        'driverNameQuery',
        'schoolNameQuery',
        'replacementDriverQuery',
        'amount',
        'oldAmount',
        'actualReplacementCost',
        'absentDriverDeduction',
        'date',
        'targetDate',
        'reason',
        'paymentMethod',
        'replyArabic',
      ],
    },
  };

  const attempts: Array<{ model: string; thinkingLevel: ThinkingLevel; timeoutMs: number }> = [
    { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL, timeoutMs: 9000 },
  ];

  for (const attempt of attempts) {
    try {
      const ai = getAiClient('v1beta');
      const response = await withTimeout(
        ai.models.generateContent({
          model: attempt.model,
          contents: transcript,
          config: {
            ...config,
            thinkingConfig: { thinkingLevel: attempt.thinkingLevel },
          },
        }),
        attempt.timeoutMs,
        `Interpret ${attempt.model}`
      );
      const cleaned = stripJsonFences(response.text || '{}');
      const parsed = JSON.parse(cleaned);
      return parsed as InterpretedVoiceCommand;
    } catch (err) {
      console.warn(`interpretEgyptianCommand failed on ${attempt.model}:`, err);
    }
  }

  return fallbackInterpretEgyptianCommand(transcript, context);
}

export async function synthesizeArabicSpeech(text: string): Promise<string | null> {
  try {
    const ai = getAiClient('v1beta');
    const response = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text,
                speechMetadata: {
                  style: 'Clear, helpful Egyptian Arabic business assistant',
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      }),
      8000,
      'TTS synthesizeArabicSpeech'
    );

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    return base64Audio || null;
  } catch (err) {
    if (isModelNotFoundError(err)) {
      console.warn('TTS model unavailable on current API key; continuing with text response.');
      return null;
    }
    console.warn('TTS synthesis failed, continuing with text response:', err);
    return null;
  }
}
