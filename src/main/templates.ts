import type { VaultTemplateId } from "../shared/ipc";

export interface VaultTemplate {
  id: VaultTemplateId;
  name: string;
  description: string;
  folders: string[];
  notes: Array<{ folderPath: string; title: string; content: string }>;
}

export const VAULT_TEMPLATES: VaultTemplate[] = [
  {
    id: "blank",
    name: "Blank vault",
    description: "Start with just the Driftleaf welcome note.",
    folders: [],
    notes: [],
  },
  {
    id: "general",
    name: "General notes",
    description: "An inbox and a place to collect project notes.",
    folders: ["Projects"],
    notes: [
      {
        folderPath: "",
        title: "Inbox",
        content: "# Inbox\n\nCapture thoughts here and organize them later.\n",
      },
      {
        folderPath: "Projects",
        title: "Project Notes",
        content: "# Project Notes\n\n## Active projects\n\n## Next actions\n",
      },
    ],
  },
  {
    id: "productivity",
    name: "To-do / Productivity",
    description: "A simple task flow from inbox to today and later.",
    folders: ["Tasks", "Projects", "Archive"],
    notes: [
      { folderPath: "Tasks", title: "Inbox", content: "# Task Inbox\n\n- [ ] \n" },
      { folderPath: "Tasks", title: "Today", content: "# Today\n\n## Priorities\n\n- [ ] \n" },
      { folderPath: "Tasks", title: "This Week", content: "# This Week\n\n- [ ] \n" },
      { folderPath: "Tasks", title: "Someday", content: "# Someday\n\n- [ ] \n" },
      {
        folderPath: "Projects",
        title: "Project List",
        content: "# Projects\n\n## Active\n\n## On hold\n",
      },
    ],
  },
  {
    id: "journal",
    name: "Journal",
    description: "A dated journal entry starter.",
    folders: ["Journal"],
    notes: [
      {
        folderPath: "Journal",
        title: "{{date}}",
        content: "# {{date}}\n\n## What happened today?\n\n## Thoughts\n\n## Tomorrow\n",
      },
    ],
  },
  {
    id: "study",
    name: "Study / School",
    description: "Organize course notes, assignments, and study sessions.",
    folders: ["Courses", "Assignments", "Study Sessions"],
    notes: [
      {
        folderPath: "Courses",
        title: "Course Template",
        content: "# Course\n\n## Topics\n\n## Notes\n",
      },
      {
        folderPath: "Assignments",
        title: "Assignment Tracker",
        content: "# Assignments\n\n| Assignment | Due | Status |\n| --- | --- | --- |\n",
      },
      {
        folderPath: "Study Sessions",
        title: "Study Log",
        content: "# Study Log\n\n## Session\n- Date:\n- Subject:\n- Focus:\n- Notes:\n",
      },
    ],
  },
];

export function getVaultTemplate(id: VaultTemplateId): VaultTemplate {
  const template = VAULT_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`Unknown vault template: ${id}`);
  return template;
}
