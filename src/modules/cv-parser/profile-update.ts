import * as Yup from 'yup';
import type { CandidateProfile } from '../../config/firebase';

/** Role and location strings are passed to the scraper as argv. Keep them short. */
export const ROLE_LOCATION_MAX_LENGTH = 80;
export const MAX_TARGET_ROLES = 20;
export const MAX_TARGET_LOCATIONS = 24;
export const MAX_SKILL_ITEMS = 40;

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
/** Newlines and tabs are allowed in the free-text summary; other controls are not. */
const SUMMARY_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export class ProfileUpdateError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join('; '));
    this.name = 'ProfileUpdateError';
    this.issues = issues;
  }
}

export interface ProfileStore {
  getProfile(): Promise<CandidateProfile | null>;
  saveProfile(profile: CandidateProfile): Promise<void>;
}

export type ProfileUpdateResult =
  | { ok: true; profile: CandidateProfile }
  | { ok: false; status: 400; error: string };

function trimmedText(
  label: string,
  max: number,
  opts: { required?: boolean; min?: number } = {},
) {
  let schema = Yup.string()
    .label(label)
    .transform((value, original) => (typeof original === 'string' ? original.trim() : value))
    .test('string-type', `${label} must be a string`, function () {
      const original = this.originalValue;
      if (original == null || original === '') return !opts.required;
      return typeof original === 'string';
    })
    .test('no-control', `${label} must not contain control characters`, (value) => {
      if (value == null || value === '') return true;
      return !CONTROL_CHARS.test(value);
    })
    .max(max);

  if (opts.required) {
    schema = schema.required().min(opts.min ?? 1);
  } else if (opts.min) {
    schema = schema.min(opts.min);
  }

  return schema;
}

function textList(
  label: string,
  opts: { maxItems: number; itemMax?: number; minItems?: number; required?: boolean },
) {
  const item = trimmedText(label, opts.itemMax ?? ROLE_LOCATION_MAX_LENGTH, { required: true, min: 1 });
  let schema = Yup.array().of(item).label(label).max(opts.maxItems);
  if (opts.required || (opts.minItems && opts.minItems > 0)) {
    schema = schema.required().min(opts.minItems ?? 1);
  }
  return schema;
}

const summarySchema = Yup.string()
  .label('professionalSummary')
  .transform((value, original) => {
    if (original == null) return undefined;
    return typeof original === 'string' ? original.trim() : value;
  })
  .test('string-type', 'professionalSummary must be a string', function () {
    const original = this.originalValue;
    if (original == null || original === '') return true;
    return typeof original === 'string';
  })
  .test('no-control', 'professionalSummary must not contain control characters', (value) => {
    if (value == null || value === '') return true;
    return !SUMMARY_CONTROL_CHARS.test(value);
  })
  .max(3000)
  .notRequired();

const salarySchema = Yup.object({
  min: Yup.number().typeError('salary min must be a number').min(0).max(10_000_000).required(),
  target: Yup.number().typeError('salary target must be a number').min(0).max(10_000_000).required(),
  currency: trimmedText('currency', 8, { required: true, min: 1 }),
})
  .noUnknown(true)
  .nullable()
  .notRequired();

const customCategorySchema = Yup.object({
  name: trimmedText('category name', 40, { required: true, min: 1 }),
  skills: textList('category skills', { maxItems: MAX_SKILL_ITEMS, itemMax: ROLE_LOCATION_MAX_LENGTH, required: true }),
}).noUnknown(true);

function skillsField() {
  return Yup.mixed()
    .notRequired()
    .test('skills-shape', 'skills must be an object of string lists without control characters', (value) => {
      if (value == null) return true;
      if (typeof value !== 'object' || Array.isArray(value)) return false;
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > 30) return false;
      for (const [key, list] of entries) {
        if (!/^[A-Za-z0-9_]{1,40}$/.test(key) || CONTROL_CHARS.test(key)) return false;
        if (list == null) continue;
        if (!Array.isArray(list) || list.length > MAX_SKILL_ITEMS) return false;
        for (const item of list) {
          if (typeof item !== 'string') return false;
          const trimmed = item.trim();
          if (trimmed.length === 0 || trimmed.length > ROLE_LOCATION_MAX_LENGTH || CONTROL_CHARS.test(trimmed)) {
            return false;
          }
        }
      }
      return true;
    });
}

export const profileUpdateSchema = Yup.object({
  name: trimmedText('name', 100, { required: true, min: 1 }),
  email: trimmedText('email', 200, { required: true, min: 3 }).email('email must be a valid email address'),
  phone: trimmedText('phone', 40, { required: true, min: 5 }),
  location: trimmedText('location', ROLE_LOCATION_MAX_LENGTH, { required: true, min: 1 }),
  professionalSummary: summarySchema,
  targetRoles: textList('targetRoles', {
    maxItems: MAX_TARGET_ROLES,
    itemMax: ROLE_LOCATION_MAX_LENGTH,
    minItems: 1,
    required: true,
  }),
  potentiallyQualifiedRoles: textList('potentiallyQualifiedRoles', {
    maxItems: MAX_TARGET_ROLES,
    itemMax: ROLE_LOCATION_MAX_LENGTH,
  }),
  targetLocations: textList('targetLocations', {
    maxItems: MAX_TARGET_LOCATIONS,
    itemMax: ROLE_LOCATION_MAX_LENGTH,
    minItems: 1,
    required: true,
  }),
  coreSkills: textList('coreSkills', { maxItems: MAX_SKILL_ITEMS, itemMax: ROLE_LOCATION_MAX_LENGTH }),
  toolsAndPlatforms: textList('toolsAndPlatforms', { maxItems: MAX_SKILL_ITEMS, itemMax: ROLE_LOCATION_MAX_LENGTH }),
  skills: skillsField(),
  customCategories: Yup.array().of(customCategorySchema).max(10).notRequired(),
  experienceYears: Yup.number()
    .typeError('experienceYears must be a number')
    .integer('experienceYears must be a whole number')
    .min(0)
    .max(60)
    .required()
    .test('number-type', 'experienceYears must be a number', function () {
      return typeof this.originalValue === 'number' && Number.isFinite(this.originalValue);
    }),
  salaryExpectationEUR: salarySchema,
  workAuthorization: trimmedText('workAuthorization', 160, { required: true, min: 1 }),
  cvStoragePath: trimmedText('cvStoragePath', 2048),
  updatedAt: trimmedText('updatedAt', 40),
}).noUnknown(true, 'unknown fields are not allowed');

function trimSkillMap(skills: CandidateProfile['skills'] | undefined): CandidateProfile['skills'] {
  if (!skills) return {};
  const trimmed: CandidateProfile['skills'] = {};
  for (const [key, list] of Object.entries(skills)) {
    if (!Array.isArray(list)) continue;
    trimmed[key] = list.map((item) => item.trim());
  }
  return trimmed;
}

export async function parseProfileUpdate(body: unknown): Promise<CandidateProfile> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProfileUpdateError(['Profile body must be a JSON object.']);
  }

  try {
    const parsed = await profileUpdateSchema.validate(body, {
      abortEarly: false,
      stripUnknown: false,
    });
    const profile = parsed as CandidateProfile;
    profile.skills = trimSkillMap(profile.skills);
    profile.cvStoragePath = profile.cvStoragePath ?? '';
    return profile;
  } catch (err) {
    if (err instanceof Yup.ValidationError) {
      throw new ProfileUpdateError(err.errors.length ? err.errors : [err.message]);
    }
    throw err;
  }
}

/**
 * Validate a profile update and persist it only when the body matches the schema.
 * Invalid bodies return 400 and do not call saveProfile.
 */
export async function applyProfileUpdate(body: unknown, store: ProfileStore): Promise<ProfileUpdateResult> {
  let profile: CandidateProfile;
  try {
    profile = await parseProfileUpdate(body);
  } catch (err) {
    if (err instanceof ProfileUpdateError) {
      return { ok: false, status: 400, error: err.message };
    }
    throw err;
  }

  const stored: CandidateProfile = {
    ...profile,
    updatedAt: new Date().toISOString(),
  };
  await store.saveProfile(stored);
  return { ok: true, profile: stored };
}
