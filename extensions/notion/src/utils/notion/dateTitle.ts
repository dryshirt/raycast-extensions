import { format } from "date-fns";

export function getDateTitle(dateFormat: string, date: Date = new Date()) {
  try {
    return format(date, dateFormat);
  } catch {
    return format(date, "yyyy-MM-dd");
  }
}
