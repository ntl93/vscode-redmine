import * as vscode from "vscode";
import { RedmineConfig } from "../definitions/redmine-config";
import { Issue } from "../redmine/models/issue";
import { RedmineProject } from "../redmine/redmine-project";
import {
  RedmineServer,
  TimeEntryRecord,
} from "../redmine/redmine-server";

interface DashboardData {
  serverUrl: string;
  issuesAssignedToMe: Issue[];
  openProjectsCount: number;
  projects: RedmineProject[];
  worktimeReport: WorktimeReportData | null;
  worktimeReportError: string | null;
  error: string | null;
}

interface WorktimeReportDay {
  date: string;
  dayLabel: string;
  weekdayLabel: string;
  weekendClass: "weekend-saturday" | "weekend-sunday" | "";
}

interface WorktimeReportRow {
  label: string;
  issueId: number | null;
  totalHours: number;
  dayHours: number[];
  isSummary: boolean;
  clickable: boolean;
}

interface WorktimeReportGroup {
  projectLabel: string;
  totalHours: number;
  rows: WorktimeReportRow[];
}

interface WorktimeReportData {
  periodLabel: string;
  totalHours: number;
  totalEntries: number;
  days: WorktimeReportDay[];
  dailyTotals: number[];
  groups: WorktimeReportGroup[];
}

interface WorktimeReportState {
  year: number;
  monthIndex: number;
  projectId: number | null;
}

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const createInitialReportState = (): WorktimeReportState => {
  const now = new Date();

  return {
    year: now.getFullYear(),
    monthIndex: now.getMonth(),
    projectId: null,
  };
};

const pad = (value: number): string => String(value).padStart(2, "0");

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

const errorToString = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err)
    return String((err as { message: unknown }).message);
  return String(err);
};

const formatHours = (hours: number): string => hours.toFixed(2);

const formatDateKey = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const formatDisplayDate = (date: Date): string =>
  `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;

export class RedmineDashboardProvider {
  public static readonly viewType = "redmine-dashboard";

  private panel?: vscode.WebviewPanel;
  private _currentServer?: RedmineServer;
  private _reportState: WorktimeReportState = createInitialReportState();

  constructor(private readonly _extensionUri: vscode.Uri) { }

  async open(server: RedmineServer): Promise<void> {
    this._currentServer = server;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      await this._refreshDashboardWithServer(server);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      RedmineDashboardProvider.viewType,
      "Redmine Dashboard",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri],
      }
    );

    const panel = this.panel;

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    panel.webview.html = this._getHtmlForWebview(panel.webview);

    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "refresh":
          await this._refreshDashboard();
          break;
        case "openIssue":
          if (message.issueId) {
            vscode.commands.executeCommand(
              "redmine.openActionsForIssue",
              false,
              undefined,
              String(message.issueId)
            );
          }
          break;
        case "worktimePrevMonth":
          this._shiftReportMonth(-1);
          await this._refreshDashboard();
          break;
        case "worktimeNextMonth":
          this._shiftReportMonth(1);
          await this._refreshDashboard();
          break;
        case "worktimeProjectChange":
          this._setReportProject(message.projectId);
          await this._refreshDashboard();
          break;
      }
    });

    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });

    await this._refreshDashboardWithServer(server);
  }

  async show(server: RedmineServer): Promise<void> {
    await this.open(server);
  }

  private _shiftReportMonth(delta: number): void {
    const shifted = new Date(
      this._reportState.year,
      this._reportState.monthIndex + delta,
      1
    );

    this._reportState = {
      year: shifted.getFullYear(),
      monthIndex: shifted.getMonth(),
      projectId: this._reportState.projectId,
    };
  }

  private _setReportProject(projectId: unknown): void {
    if (projectId === null || projectId === undefined || projectId === "") {
      this._reportState.projectId = null;
      return;
    }

    const parsedProjectId = Number(projectId);
    this._reportState.projectId = Number.isNaN(parsedProjectId)
      ? null
      : parsedProjectId;
  }

  private _getReportPeriod() {
    const startDate = new Date(
      this._reportState.year,
      this._reportState.monthIndex,
      1
    );
    const endDate = new Date(
      this._reportState.year,
      this._reportState.monthIndex + 1,
      0
    );

    const days: WorktimeReportDay[] = [];

    for (let day = 1; day <= endDate.getDate(); day += 1) {
      const currentDate = new Date(
        this._reportState.year,
        this._reportState.monthIndex,
        day
      );
      const dayOfWeek = currentDate.getDay();

      days.push({
        date: formatDateKey(currentDate),
        dayLabel: String(day),
        weekdayLabel: weekdayLabels[dayOfWeek],
        weekendClass:
          dayOfWeek === 6
            ? "weekend-saturday"
            : dayOfWeek === 0
              ? "weekend-sunday"
              : "",
      });
    }

    return {
      start: formatDateKey(startDate),
      end: formatDateKey(endDate),
      label: `${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`,
      days,
    };
  }

  private _getTimeEntryIssueId(entry: TimeEntryRecord): number | null {
    return entry.issue?.id ?? entry.issue_id ?? null;
  }

  private async _loadIssueDetailsById(
    server: RedmineServer,
    issueIds: number[]
  ): Promise<Map<number, Issue>> {
    const issueDetails = new Map<number, Issue>();

    if (issueIds.length === 0) {
      return issueDetails;
    }

    const issues = await server.getIssuesByIds(issueIds);
    for (const issue of issues) {
      issueDetails.set(issue.id, issue);
    }

    return issueDetails;
  }

  private async _loadWorktimeReport(
    server: RedmineServer
  ): Promise<WorktimeReportData> {
    const period = this._getReportPeriod();
    const entries = await server.getTimeEntries({
      from: period.start,
      to: period.end,
      userId: "me",
      projectId: this._reportState.projectId ?? undefined,
    });

    const issueIds = [...new Set(entries.map((entry) => this._getTimeEntryIssueId(entry)).filter((issueId): issueId is number => issueId !== null))];
    const issueDetailsById = await this._loadIssueDetailsById(server, issueIds);

    return this._buildWorktimeReportData(entries, issueDetailsById, period);
  }

  private _buildWorktimeReportData(
    entries: TimeEntryRecord[],
    issueDetailsById: Map<number, Issue>,
    period: {
      label: string;
      days: WorktimeReportDay[];
    }
  ): WorktimeReportData {
    const dayIndexByDate = new Map(
      period.days.map((day, index) => [day.date, index] as const)
    );
    const dailyTotals = period.days.map(() => 0);
    const groups = new Map<
      string,
      {
        projectLabel: string;
        totalHours: number;
        summaryRow: WorktimeReportRow;
        rows: Map<string, WorktimeReportRow>;
      }
    >();

    let totalHours = 0;

    for (const entry of entries) {
      const dayIndex = dayIndexByDate.get(entry.spent_on);
      if (dayIndex === undefined) {
        continue;
      }

      const hours = Number(entry.hours) || 0;
      const issueId = this._getTimeEntryIssueId(entry);
      const issueDetails = issueId ? issueDetailsById.get(issueId) : undefined;
      const projectLabel =
        entry.project?.name ??
        entry.issue?.project?.name ??
        issueDetails?.project?.name ??
        "Unknown project";
      const rowKey = issueId
        ? `issue:${issueId}`
        : `entry:${entry.id}:${entry.activity?.name ?? entry.comments ?? projectLabel}`;
      const rowLabel = issueId
        ? `#${issueId} ${issueDetails?.subject ?? entry.issue?.subject ?? "Untitled issue"}`
        : (entry.comments?.trim() || entry.activity?.name || projectLabel);

      let group = groups.get(projectLabel);
      if (!group) {
        group = {
          projectLabel,
          totalHours: 0,
          summaryRow: {
            label: projectLabel,
            issueId: null,
            totalHours: 0,
            dayHours: period.days.map(() => 0),
            isSummary: true,
            clickable: false,
          },
          rows: new Map(),
        };
        groups.set(projectLabel, group);
      }

      group.totalHours += hours;
      group.summaryRow.totalHours += hours;
      group.summaryRow.dayHours[dayIndex] += hours;

      let row = group.rows.get(rowKey);
      if (!row) {
        row = {
          label: rowLabel,
          issueId,
          totalHours: 0,
          dayHours: period.days.map(() => 0),
          isSummary: false,
          clickable: issueId !== null,
        };
        group.rows.set(rowKey, row);
      }

      row.totalHours += hours;
      row.dayHours[dayIndex] += hours;
      dailyTotals[dayIndex] += hours;
      totalHours += hours;
    }

    const sortedGroups = [...groups.values()].sort((left, right) =>
      left.projectLabel.localeCompare(right.projectLabel)
    );

    const groupedRows = sortedGroups.map((group) => {
      const issueRows = [...group.rows.values()].sort((left, right) => {
        if (right.totalHours !== left.totalHours) {
          return right.totalHours - left.totalHours;
        }
        return left.label.localeCompare(right.label);
      });

      return {
        projectLabel: group.projectLabel,
        totalHours: group.totalHours,
        rows: [group.summaryRow, ...issueRows],
      };
    });

    return {
      periodLabel: period.label,
      totalHours,
      totalEntries: entries.length,
      days: period.days,
      dailyTotals,
      groups: groupedRows,
    };
  }

  private async _refreshDashboardWithServer(
    server: RedmineServer
  ): Promise<void> {
    if (!this.panel) return;

    const [issuesResult, projectsResult, reportResult] =
      await Promise.allSettled([
        server.getIssuesAssignedToMe(),
        server.getProjects(),
        this._loadWorktimeReport(server),
      ]);

    const issuesAssignedToMe =
      issuesResult.status === "fulfilled" ? issuesResult.value.issues || [] : [];
    const projects =
      projectsResult.status === "fulfilled" ? projectsResult.value : [];

    const generalErrors: string[] = [];
    if (issuesResult.status === "rejected") {
      generalErrors.push(`Issues: ${errorToString(issuesResult.reason)}`);
    }
    if (projectsResult.status === "rejected") {
      generalErrors.push(`Projects: ${errorToString(projectsResult.reason)}`);
    }

    const worktimeReport =
      reportResult.status === "fulfilled" ? reportResult.value : null;
    const worktimeReportError =
      reportResult.status === "rejected"
        ? errorToString(reportResult.reason)
        : null;

    this._updateWebview({
      serverUrl: server.options.address,
      issuesAssignedToMe,
      openProjectsCount: projects.length,
      projects,
      worktimeReport,
      worktimeReportError,
      error: generalErrors.length ? generalErrors.join(" | ") : null,
    });
  }

  private async _refreshDashboard(): Promise<void> {
    if (!this.panel) return;
    if (this._currentServer) {
      await this._refreshDashboardWithServer(this._currentServer);
      return;
    }

    await this._refreshFromCurrentConfiguration();
  }

  async updateServer(server: RedmineServer): Promise<void> {
    this._currentServer = server;

    if (this.panel) {
      await this._refreshDashboardWithServer(server);
    }
  }

  private async _refreshFromCurrentConfiguration(): Promise<void> {
    if (!this.panel) return;

    try {
      const config = vscode.workspace.getConfiguration(
        "redmine"
      ) as RedmineConfig;

      const server = new RedmineServer({
        address: config.url,
        key: config.apiKey,
        additionalHeaders: config.additionalHeaders,
        rejectUnauthorized: config.rejectUnauthorized,
      });

      this._currentServer = server;
      await this._refreshDashboardWithServer(server);
    } catch (error) {
      this._updateWebview({
        serverUrl: "",
        issuesAssignedToMe: [],
        openProjectsCount: 0,
        projects: [],
        worktimeReport: null,
        worktimeReportError: null,
        error: errorToString(error),
      });
    }
  }

  private _updateWebview(
    data: DashboardData | null,
    error: string | null = null
  ): void {
    if (!this.panel) return;

    const overallError = error ?? data?.error ?? null;

    const issuesHtml = data
      ? data.issuesAssignedToMe
        .map((issue) => {
          const subjectEscaped = escapeHtml(issue.subject);
          const descriptionEscaped = escapeHtml(issue.description || "");
          const authorName = escapeHtml(issue.author?.name ?? "Unknown");
          const assigneeName = escapeHtml(issue.assigned_to?.name ?? "Unassigned");
          const trackerName = escapeHtml(issue.tracker?.name ?? "");
          const statusName = escapeHtml(issue.status?.name ?? "");
          const priorityName = escapeHtml(issue.priority?.name ?? "");
          const createdOn = issue.created_on
            ? new Date(issue.created_on).toLocaleDateString()
            : "";
          const dueDate = issue.due_date
            ? new Date(issue.due_date).toLocaleDateString()
            : "";

          return `<div class="issue-card" data-issue-id="${issue.id}">
            <div class="issue-header">
              <span class="issue-id">#${issue.id}</span>
              <span class="issue-subject">${subjectEscaped}</span>
            </div>
            <div class="issue-meta">
              ${trackerName ? `<span class="badge tracker">${trackerName}</span>` : ""}
              ${statusName ? `<span class="badge status">${statusName}</span>` : ""}
              ${priorityName ? `<span class="badge priority">${priorityName}</span>` : ""}
            </div>
            <div class="issue-description">${descriptionEscaped}</div>
            <div class="issue-details">
              <span>Author: ${authorName}</span>
              <span>Assigned to: ${assigneeName}</span>
              ${createdOn ? `<span>Created: ${createdOn}</span>` : ""}
              ${dueDate ? `<span>Due: ${dueDate}</span>` : ""}
            </div>
          </div>`;
        })
        .join("")
      : "";

    const errorHtml = overallError
      ? `<div class="error-banner">Error: ${escapeHtml(overallError)}</div>`
      : "";

    const worktimeReportHtml = this._buildWorktimeReportSection(
      data?.worktimeReport ?? null,
      data?.projects ?? [],
      data?.worktimeReportError ?? null
    );

    const issuesCount = data ? data.issuesAssignedToMe.length : 0;
    const projectsCount = data ? data.openProjectsCount : 0;

    this.panel.webview.html = this._getHtmlForWebview(
      this.panel.webview,
      data?.serverUrl ?? "",
      issuesHtml,
      errorHtml,
      issuesCount,
      projectsCount,
      worktimeReportHtml
    );
  }

  private _buildProjectOptionsHtml(projects: RedmineProject[]): string {
    const sortedProjects = projects
      .map((project) => ({
        id: project.id,
        label: project.toQuickPickItem().label,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));

    const selectedProjectId = this._reportState.projectId;

    return [
      `<option value=""${selectedProjectId === null ? " selected" : ""}>Restrict project...</option>`,
      ...sortedProjects.map(
        (project) =>
          `<option value="${project.id}"${selectedProjectId === project.id ? " selected" : ""}>${escapeHtml(project.label)}</option>`
      ),
    ].join("");
  }

  private _buildWorktimeReportSection(
    report: WorktimeReportData | null,
    projects: RedmineProject[],
    reportError: string | null
  ): string {
    const periodLabel = report?.periodLabel ?? this._getReportPeriod().label;
    const projectOptionsHtml = this._buildProjectOptionsHtml(projects);
    const summaryHtml = report
      ? `<div class="worktime-summary-chips">
          <span class="worktime-summary-chip">${formatHours(report.totalHours)} h total</span>
          <span class="worktime-summary-chip">${report.totalEntries} entries</span>
          <span class="worktime-summary-chip">${report.groups.length} projects</span>
        </div>`
      : `<div class="worktime-summary-chips"><span class="worktime-summary-chip">No worktime data loaded</span></div>`;
    const reportTableHtml = report
      ? this._buildWorktimeReportTableHtml(report)
      : `<div class="no-issues">No worktime report available for the selected period.</div>`;
    const reportErrorHtml = reportError
      ? `<div class="error-banner">Worktime report: ${escapeHtml(reportError)}</div>`
      : "";

    return `
      <section class="worktime-report">
        <div class="worktime-report-header">
          <div>
            <div class="section-title">Worktime Report</div>
            <div class="worktime-report-period">${escapeHtml(periodLabel)}</div>
          </div>
          <div class="worktime-report-controls">
            <div class="worktime-month-nav">
              <button type="button" class="report-nav-btn" data-report-action="worktimePrevMonth">&laquo;</button>
              <span class="worktime-month-label">${escapeHtml(periodLabel)}</span>
              <button type="button" class="report-nav-btn" data-report-action="worktimeNextMonth">&raquo;</button>
            </div>
            <select id="worktimeProjectSelect" class="worktime-project-select">
              ${projectOptionsHtml}
            </select>
          </div>
        </div>

        ${summaryHtml}
        ${reportErrorHtml}
        ${reportTableHtml}
      </section>`;
  }

  private _buildWorktimeReportTableHtml(report: WorktimeReportData): string {
    if (!report.groups.length) {
      return `<div class="no-issues">No time entries were found for this period.</div>`;
    }

    const headerCells = report.days
      .map(
        (day) => `
          <th class="worktime-day-header ${day.weekendClass}">
            <span class="worktime-day-number">${escapeHtml(day.dayLabel)}</span>
            <span class="worktime-day-weekday">${escapeHtml(day.weekdayLabel)}</span>
          </th>`
      )
      .join("");

    const bodyRows = report.groups
      .map((group) => {
        const rows = group.rows
          .map((row) => {
            const rowCells = row.dayHours
              .map(
                (hours, index) => `
                  <td class="worktime-day-cell ${report.days[index].weekendClass}">
                    ${hours > 0 ? formatHours(hours) : ""}
                  </td>`
              )
              .join("");
            const rowClass = row.isSummary
              ? "worktime-row worktime-summary-row"
              : row.clickable
                ? "worktime-row worktime-entry-row worktime-entry-row-clickable"
                : "worktime-row worktime-entry-row";
            const labelContent = row.isSummary
              ? `<span class="worktime-summary-label">${escapeHtml(row.label)}</span>`
              : escapeHtml(row.label);
            const rowAttributes = row.clickable && row.issueId
              ? ` data-issue-id="${row.issueId}"`
              : "";

            return `
              <tr class="${rowClass}"${rowAttributes}>
                <th class="worktime-label-col">${labelContent}</th>
                <td class="worktime-total-col">${formatHours(row.totalHours)}</td>
                ${rowCells}
              </tr>`;
          })
          .join("");

        return rows;
      })
      .join("");

    const totalCells = report.dailyTotals
      .map(
        (hours, index) => `
          <td class="worktime-day-total ${report.days[index].weekendClass}">
            ${hours > 0 ? formatHours(hours) : ""}
          </td>`
      )
      .join("");

    const grandTotalRowHtml = `
      <tr class="worktime-grand-total-row">
        <th class="worktime-label-col">Total</th>
        <td class="worktime-total-col">${formatHours(report.totalHours)}</td>
        ${totalCells}
      </tr>`;

    return `
      <div class="worktime-table-wrap">
        <table class="worktime-table">
          <thead>
            <tr>
              <th class="worktime-label-col">Task</th>
              <th class="worktime-total-col">Total</th>
              ${headerCells}
            </tr>
          </thead>
          <tbody>
            ${grandTotalRowHtml}
            ${bodyRows}
          </tbody>
        </table>
      </div>`;
  }

  private _getHtmlForWebview(
    webview: vscode.Webview,
    serverUrl: string = "",
    issuesHtml: string = "",
    errorHtml: string = "",
    issuesCount: number = 0,
    projectsCount: number = 0,
    worktimeReportHtml: string = ""
  ): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Redmine Dashboard</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 13px;
          color: #24292e;
          background: #ffffff;
          padding: 16px;
        }

        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 1px solid #e1e4e8;
        }

        .header h2 {
          font-size: 16px;
          font-weight: 600;
          color: #24292e;
        }

        .stats {
          display: flex;
          gap: 16px;
          margin-bottom: 16px;
        }

        .stat-card {
          flex: 1;
          background: #f6f8fa;
          border: 1px solid #e1e4e8;
          border-radius: 6px;
          padding: 12px;
          text-align: center;
        }

        .stat-card .stat-value {
          font-size: 24px;
          font-weight: 600;
          color: #0366d6;
        }

        .stat-card .stat-label {
          font-size: 11px;
          color: #586069;
          margin-top: 4px;
        }

        .server-info {
          background: #f6f8fa;
          border: 1px solid #e1e4e8;
          border-radius: 6px;
          padding: 8px 12px;
          margin-bottom: 16px;
          font-size: 12px;
        }

        .server-info a {
          color: #0366d6;
          text-decoration: none;
        }

        .server-info a:hover {
          text-decoration: underline;
        }

        .error-banner {
          background: #ffeef0;
          border: 1px solid #d73a49;
          border-radius: 6px;
          padding: 12px;
          margin-bottom: 16px;
          color: #cb2431;
          font-size: 13px;
        }

        .section-title {
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 8px;
          color: #24292e;
        }

        .issue-card {
          border: 1px solid #e1e4e8;
          border-radius: 6px;
          padding: 12px;
          margin-bottom: 8px;
          cursor: pointer;
          transition: background-color 0.15s ease, border-color 0.15s ease;
        }

        .issue-card:hover {
          background-color: #f6f8fa;
          border-color: #0366d6;
        }

        .issue-header {
          display: flex;
          align-items: baseline;
          gap: 8px;
          margin-bottom: 6px;
        }

        .issue-id {
          font-weight: 600;
          color: #586069;
          font-size: 12px;
        }

        .issue-subject {
          font-weight: 600;
          color: #24292e;
          flex: 1;
        }

        .issue-meta {
          display: flex;
          gap: 4px;
          margin-bottom: 6px;
          flex-wrap: wrap;
        }

        .badge {
          display: inline-block;
          padding: 1px 8px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 500;
        }

        .badge.tracker {
          background: #e6f3ff;
          color: #0366d6;
        }

        .badge.status {
          background: #e6f3ff;
          color: #0366d6;
        }

        .badge.priority {
          background: #fff8c5;
          color: #735c0f;
        }

        .issue-description {
          color: #586069;
          font-size: 12px;
          margin-bottom: 6px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          line-height: 1.4;
        }

        .issue-details {
          display: flex;
          gap: 12px;
          font-size: 11px;
          color: #6a737d;
          flex-wrap: wrap;
        }

        .refresh-btn {
          background: none;
          border: 1px solid #e1e4e8;
          border-radius: 6px;
          padding: 4px 10px;
          cursor: pointer;
          font-size: 12px;
          color: #586069;
          transition: background-color 0.15s ease;
        }

        .refresh-btn:hover {
          background-color: #f3f4f6;
          color: #0366d6;
        }

        .no-issues {
          text-align: center;
          padding: 24px;
          color: #6a737d;
          font-size: 13px;
        }

        .worktime-report {
          margin-bottom: 20px;
          padding: 12px;
          border: 1px solid #e1e4e8;
          border-radius: 8px;
          background: #fafbfc;
        }

        .worktime-report-header {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: flex-start;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }

        .worktime-report-period {
          font-size: 12px;
          color: #586069;
          margin-top: 2px;
        }

        .worktime-report-controls {
          display: flex;
          flex-direction: column;
          gap: 8px;
          align-items: flex-end;
        }

        .worktime-month-nav {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .report-nav-btn {
          background: #fff;
          border: 1px solid #d0d7de;
          border-radius: 6px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 12px;
          color: #24292e;
        }

        .report-nav-btn:hover {
          background: #f3f4f6;
        }

        .worktime-month-label {
          min-width: 180px;
          text-align: center;
          font-size: 12px;
          color: #24292e;
        }

        .worktime-project-select {
          min-width: 220px;
          border: 1px solid #d0d7de;
          border-radius: 6px;
          padding: 5px 8px;
          font-size: 12px;
          color: #24292e;
          background: #fff;
        }

        .worktime-summary-chips {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 12px;
        }

        .worktime-summary-chip {
          display: inline-flex;
          align-items: center;
          border: 1px solid #e1e4e8;
          border-radius: 999px;
          background: #fff;
          padding: 3px 10px;
          font-size: 11px;
          color: #586069;
        }

        .worktime-table-wrap {
          overflow-x: auto;
          border: 1px solid #e1e4e8;
          border-radius: 8px;
          background: #fff;
        }

        .worktime-table {
          width: 100%;
          min-width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
        }

        .worktime-table th,
        .worktime-table td {
          border-right: 1px solid #e1e4e8;
          border-bottom: 1px solid #e1e4e8;
          padding: 4px 6px;
          text-align: center;
          white-space: nowrap;
        }

        .worktime-table th.worktime-label-col {
          position: sticky;
          left: 0;
          z-index: 2;
          text-align: left;
          width: 420px;
          min-width: 420px;
          max-width: 420px;
          background: #fff;
          white-space: normal;
          overflow-wrap: anywhere;
          word-break: break-word;
          vertical-align: top;
          line-height: 1.3;
        }

        .worktime-table .worktime-total-col {
          position: sticky;
          left: 420px;
          z-index: 1;
          width: 96px;
          min-width: 96px;
          max-width: 96px;
          background: #fff;
        }

        .worktime-day-header {
          min-width: 44px;
          font-size: 11px;
          line-height: 1.1;
          background: #f8f9fa;
        }

        .worktime-day-number {
          display: block;
          font-weight: 600;
        }

        .worktime-day-weekday {
          display: block;
          color: #6a737d;
          margin-top: 2px;
        }

        .worktime-day-cell,
        .worktime-day-total {
          min-width: 44px;
          font-variant-numeric: tabular-nums;
        }

        .weekend-saturday {
          background: #eef2ff;
        }

        .weekend-sunday {
          background: #fff1f2;
        }

        .worktime-summary-row {
          background: #111827;
          color: #fff;
        }

        .worktime-summary-row th.worktime-label-col,
        .worktime-summary-row .worktime-total-col,
        .worktime-summary-row td {
          background: #111827;
          color: #fff;
          border-color: #2d3748;
        }

        .worktime-summary-label {
          font-weight: 700;
        }

        .worktime-entry-row-clickable {
          cursor: pointer;
        }

        .worktime-entry-row:hover {
          background: #f6f8fa;
        }

        .worktime-entry-row:hover .worktime-label-col,
        .worktime-entry-row:hover .worktime-total-col {
          background: #f6f8fa;
        }

        .worktime-grand-total-row {
          background: #f6f8fa;
          font-weight: 600;
        }

        .worktime-grand-total-row .worktime-label-col,
        .worktime-grand-total-row .worktime-total-col {
          background: #f6f8fa;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>Redmine Dashboard</h2>
        <button class="refresh-btn" id="refreshBtn">&#x21bb; Refresh</button>
      </div>

      ${serverUrl
        ? `<div class="server-info">Connected to: <a href="#" id="openServerLink">${serverUrl}</a></div>`
        : ""
      }

      <div class="stats">
        <div class="stat-card">
          <div class="stat-value">${issuesCount}</div>
          <div class="stat-label">Open Issues</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${projectsCount}</div>
          <div class="stat-label">Projects</div>
        </div>
      </div>

      ${errorHtml}

      ${worktimeReportHtml}

      <div class="section-title">Issues Assigned to Me (${issuesCount})</div>

      ${issuesHtml ||
      `<div class="no-issues">No open issues assigned to you.</div>`
      }

      <script>
        const vscodeApi = acquireVsCodeApi();
        const refreshBtn = document.getElementById('refreshBtn');
        const openServerLink = document.getElementById('openServerLink');
        const worktimeProjectSelect = document.getElementById('worktimeProjectSelect');
        const reportActionButtons = document.querySelectorAll('[data-report-action]');

        refreshBtn.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'refresh' });
        });

        reportActionButtons.forEach((button) => {
          button.addEventListener('click', () => {
            const action = button.getAttribute('data-report-action');
            if (action) {
              vscodeApi.postMessage({ type: action });
            }
          });
        });

        if (worktimeProjectSelect) {
          worktimeProjectSelect.addEventListener('change', () => {
            const value = worktimeProjectSelect.value;
            vscodeApi.postMessage({
              type: 'worktimeProjectChange',
              projectId: value ? Number(value) : null,
            });
          });
        }

        ${serverUrl
        ? `if (openServerLink) {
              openServerLink.addEventListener('click', (e) => {
                e.preventDefault();
                vscodeApi.postMessage({
                  type: 'openExternal',
                  url: ${JSON.stringify(serverUrl)},
                });
              });
            }`
        : ""
      }

        document.querySelectorAll('.issue-card, .worktime-entry-row[data-issue-id]').forEach((card) => {
          card.addEventListener('click', () => {
            const issueId = parseInt(card.getAttribute('data-issue-id') || '', 10);
            if (!Number.isNaN(issueId)) {
              vscodeApi.postMessage({ type: 'openIssue', issueId });
            }
          });
        });
      </script>
    </body>
    </html>`;
  }
}
