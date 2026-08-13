import applicationSettingModel from '../models/ApplicationSetting.model.js';

export const RECEIPT_CONFIGURATION_KEY = 'receipt_configuration_v1';

export const RECEIPT_COMPONENTS = Object.freeze([
  'header',
  'document',
  'amount',
  'details',
  'note',
  'signatures',
  'footer',
]);

export const RECEIPT_CONFIGURATION_DEFAULTS = Object.freeze({
  template: 'classic',
  paper_size: 'A4',
  accent_color: '#166534',
  body_font: 'inter',
  heading_font: 'georgia',
  text_scale: 100,
  header_title: '',
  header_subtitle: '',
  document_title: '',
  amount_label: '',
  footer_note: 'This is a computer-generated receipt and does not require a revenue stamp.',
  component_order: RECEIPT_COMPONENTS,
  custom_fields: [],
  show_border: true,
  show_amount_words: true,
  show_party: true,
  show_payment_mode: true,
  show_reference: true,
  show_bank_details: true,
  show_allocation: true,
  show_remarks: true,
  show_status: true,
  show_recorded_by: true,
  show_extra_note: true,
  show_signatures: true,
  show_verification_qr: true,
  show_printed_at: true,
});

const TEMPLATES = new Set(['classic', 'modern', 'executive', 'minimal', 'heritage', 'compact']);
const PAPER_SIZES = new Set(['A4', 'A5']);
const FONTS = new Set(['inter', 'humanist', 'georgia', 'garamond', 'system']);
const BOOLEAN_KEYS = Object.keys(RECEIPT_CONFIGURATION_DEFAULTS)
  .filter((key) => key.startsWith('show_'));

const limitedText = (value, maxLength) => String(value ?? '').trim().slice(0, maxLength);
const boundedInteger = (value, minimum, maximum, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.round(number))) : fallback;
};

const normaliseCustomFields = (raw) => {
  const fields = Array.isArray(raw) ? raw.slice(0, 12) : [];
  const usedIds = new Set();
  return fields.map((field, index) => {
    const input = field && typeof field === 'object' && !Array.isArray(field) ? field : {};
    const baseId = limitedText(input.id, 64).replace(/[^a-z0-9_-]/gi, '') || `field-${index + 1}`;
    let id = baseId;
    let duplicate = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${duplicate}`;
      duplicate += 1;
    }
    usedIds.add(id);
    return {
      id,
      label: limitedText(input.label, 60),
      value: limitedText(input.value, 160),
      enabled: input.enabled !== false,
    };
  });
};

/** Coerce a stored or posted value into the stable public receipt contract. */
export const normaliseReceiptConfiguration = (raw) => {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const template = String(input.template || '').toLowerCase();
  const paperSize = String(input.paper_size || '').toUpperCase();
  const accentColor = String(input.accent_color || '').trim();
  const bodyFont = String(input.body_font || '').toLowerCase();
  const headingFont = String(input.heading_font || '').toLowerCase();
  const config = {
    ...RECEIPT_CONFIGURATION_DEFAULTS,
    template: TEMPLATES.has(template) ? template : RECEIPT_CONFIGURATION_DEFAULTS.template,
    paper_size: PAPER_SIZES.has(paperSize) ? paperSize : RECEIPT_CONFIGURATION_DEFAULTS.paper_size,
    accent_color: /^#[0-9a-f]{6}$/i.test(accentColor)
      ? accentColor.toLowerCase()
      : RECEIPT_CONFIGURATION_DEFAULTS.accent_color,
    body_font: FONTS.has(bodyFont) ? bodyFont : RECEIPT_CONFIGURATION_DEFAULTS.body_font,
    heading_font: FONTS.has(headingFont) ? headingFont : RECEIPT_CONFIGURATION_DEFAULTS.heading_font,
    text_scale: boundedInteger(input.text_scale, 80, 130, RECEIPT_CONFIGURATION_DEFAULTS.text_scale),
    header_title: limitedText(input.header_title, 100),
    header_subtitle: limitedText(input.header_subtitle, 220),
    document_title: limitedText(input.document_title, 100),
    amount_label: limitedText(input.amount_label, 80),
    footer_note: limitedText(input.footer_note, 320) || RECEIPT_CONFIGURATION_DEFAULTS.footer_note,
    component_order: (() => {
      const posted = Array.isArray(input.component_order) ? input.component_order : [];
      const valid = [...new Set(posted.map((value) => String(value)).filter((value) => RECEIPT_COMPONENTS.includes(value)))];
      return [...valid, ...RECEIPT_COMPONENTS.filter((value) => !valid.includes(value))];
    })(),
    custom_fields: normaliseCustomFields(input.custom_fields),
  };

  for (const key of BOOLEAN_KEYS) {
    if (typeof input[key] === 'boolean') config[key] = input[key];
  }
  return config;
};

export const getReceiptConfiguration = async (siteId) => normaliseReceiptConfiguration(
  await applicationSettingModel.getJson(siteId, RECEIPT_CONFIGURATION_KEY, null),
);

export const saveReceiptConfiguration = async (siteId, raw, userId) => {
  const config = normaliseReceiptConfiguration(raw);
  await applicationSettingModel.setJson(siteId, RECEIPT_CONFIGURATION_KEY, config, userId);
  return config;
};
