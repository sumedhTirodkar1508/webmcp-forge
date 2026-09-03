import type { PageExtraction, RepeatedGroup, ScanRepresentation } from "@/lib/scanner/types";

/**
 * Deciding when a scan is *semantically* ambiguous.
 *
 * Visual assistance is expensive and carries real risk, so it must be the
 * exception. This module answers one narrow question: did deterministic
 * extraction find enough structure, but leave genuine doubt about what that
 * structure MEANS?
 *
 * It deliberately does not escalate merely because a page is large, or because
 * a scan found a lot of groups. Size is not ambiguity.
 */

/** Groups whose scores are within this fraction are "too close to call". */
const CLOSE_SCORE_RATIO = 0.2;

/** Below this, a group's discovered fields are too thin to interpret. */
const LOW_COVERAGE = 0.6;

export type AmbiguityReason =
  | "competing_groups"
  | "low_field_coverage"
  | "similar_structures"
  | "no_clear_project_group";

export interface AmbiguousSection {
  /** Which semantic section is in doubt. */
  section: "projects" | "skills" | "experience" | "education" | "profile";
  reason: AmbiguityReason;
  /** The page the doubt is on. */
  pageUrl: string;
  /** Candidate group ids that are competing, when relevant. */
  groupIds: string[];
  /** Higher is more worth spending a screenshot on. */
  priority: number;
}

export interface AmbiguityAssessment {
  ambiguous: boolean;
  sections: AmbiguousSection[];
}

function averageCoverage(group: RepeatedGroup): number {
  const fields = Object.values(group.fields);
  if (fields.length === 0) return 0;
  return fields.reduce((total, field) => total + field.coverage, 0) / fields.length;
}

/** Groups that plausibly hold content, ordered strongest first. */
function contentGroups(page: PageExtraction): RepeatedGroup[] {
  return page.repeatedGroups
    .filter((group) => group.count >= 2 && Object.keys(group.fields).length > 0)
    .slice()
    .sort((a, b) => b.score - a.score);
}

/**
 * Section priority, matching the order the architecture asks for: the
 * genuinely ambiguous group first, then projects, skills, then the two that are
 * structurally hard to tell apart.
 */
const SECTION_PRIORITY: Record<AmbiguousSection["section"], number> = {
  projects: 90,
  skills: 70,
  experience: 50,
  education: 45,
  profile: 30,
};

export function assessAmbiguity(representation: ScanRepresentation): AmbiguityAssessment {
  const sections: AmbiguousSection[] = [];

  for (const page of representation.pages) {
    const groups = contentGroups(page);
    if (groups.length === 0) continue;

    const [best, second] = groups;
    if (!best) continue;

    const section: AmbiguousSection["section"] =
      page.pageType === "WORK_INDEX" || page.pageType === "HOME"
        ? "projects"
        : page.pageType === "EXPERIENCE"
          ? "experience"
          : page.pageType === "EDUCATION"
            ? "education"
            : "projects";

    // Two candidates scoring almost the same is the clearest signal that the
    // structure is fine but the meaning is not decidable from markup alone.
    if (second && best.score > 0) {
      const gap = (best.score - second.score) / best.score;
      if (gap <= CLOSE_SCORE_RATIO) {
        sections.push({
          section,
          reason: "competing_groups",
          pageUrl: page.url,
          groupIds: [best.id, second.id],
          priority: SECTION_PRIORITY[section],
        });
        continue;
      }
    }

    // Structure exists, but the fields inside it are too sparse to label.
    if (averageCoverage(best) < LOW_COVERAGE) {
      sections.push({
        section,
        reason: "low_field_coverage",
        pageUrl: page.url,
        groupIds: [best.id],
        priority: SECTION_PRIORITY[section] - 10,
      });
      continue;
    }

    // Experience and education lists look structurally identical very often.
    if (
      (page.pageType === "EXPERIENCE" || page.pageType === "EDUCATION") &&
      groups.length >= 2 &&
      groups.slice(0, 2).every((group) => Object.keys(group.fields).length <= 2)
    ) {
      sections.push({
        section,
        reason: "similar_structures",
        pageUrl: page.url,
        groupIds: groups.slice(0, 2).map((group) => group.id),
        priority: SECTION_PRIORITY[section],
      });
    }
  }

  // A work-index page with no usable group at all is worth a look.
  const workIndex = representation.pages.find((page) => page.pageType === "WORK_INDEX");
  if (workIndex && contentGroups(workIndex).length === 0 && !workIndex.lowInformation) {
    sections.push({
      section: "projects",
      reason: "no_clear_project_group",
      pageUrl: workIndex.url,
      groupIds: [],
      priority: SECTION_PRIORITY.projects + 5,
    });
  }

  sections.sort((a, b) => b.priority - a.priority);

  return { ambiguous: sections.length > 0, sections };
}
