'use strict';

// Curated public names for the groups of related v1.3 files.
//
// The private batch groups related files by directory, and those directory
// names are part of what is being withheld. These seven entries are the
// hand-written public counterparts: a title a reader can understand, attached
// to a group by matching a path fragment that is never itself emitted.
//
// The list lives in its own module because two surfaces depend on it — the
// research update and the public Source Library — and a family title that
// differed between them would be a bug the release gate could not see.
//
// `match` fragments are internal. They are compared against the private
// relative path in lower case; nothing in this file except `id` and `title`
// may ever reach a response.
const SOURCE_FAMILIES = [
  {
    id: 'lak_russian_epics',
    title: 'Lak and Russian epic versions',
    family: 'parallel_language_versions',
    method: 'paired_language_files',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['/lakepics/'],
  },
  {
    id: 'ttul_daghustan',
    title: 'Gamzatov — Ttul Daghustan versions',
    family: 'edition_versions',
    method: 'multiple_editions_of_one_work',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['ttuldaghustan', 'ttul daghusttan', 'ttuldaghestan'],
  },
  {
    id: 'authier_tales',
    title: 'Authier — Lak tales in Cyrillic and Latin',
    family: 'script_versions',
    method: 'cyrillic_latin_script_pair',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['laktalesauthierversion'],
  },
  {
    id: 'tolstoy_versions',
    title: 'Tolstoy in Lak — Cyrillic and Latin versions',
    family: 'script_versions',
    method: 'cyrillic_latin_script_pair',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['tolstoylak'],
  },
  {
    id: 'lorca',
    title: 'García Lorca — Lak and Russian versions',
    family: 'translated_work_versions',
    method: 'translated_work_version_set',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['garcia lorca'],
  },
  {
    id: 'eleonora_materials',
    title: 'Eleonora — transcription and translation material',
    family: 'fieldwork_transcription',
    method: 'transcription_translation_pair',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['eleonoramaterials'],
  },
  {
    id: 'war_pilot',
    title: 'War — Russian/Lak pilot set',
    family: 'parallel_language_versions',
    method: 'paired_language_files',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['/war/', '/war-1a.'],
  },
];

const FAMILY_IDS = SOURCE_FAMILIES.map(f => f.id);
const FAMILY_TITLES = Object.fromEntries(SOURCE_FAMILIES.map(f => [f.id, f.title]));

// The curated family a private path belongs to, or null. Callers pass the
// private path; only the returned id is publishable.
function familyIdForPath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return null;
  const needle = ('/' + relativePath.replace(/\\/g, '/')).toLowerCase();
  for (const family of SOURCE_FAMILIES) {
    if (family.match.some(fragment => needle.includes(fragment))) return family.id;
  }
  return null;
}

module.exports = { SOURCE_FAMILIES, FAMILY_IDS, FAMILY_TITLES, familyIdForPath };
