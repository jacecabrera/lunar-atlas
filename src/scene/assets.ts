// Base-aware URLs for files in public/ (works at / and at sub-paths such as /moon-planner/).
export const publicUrl = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`
