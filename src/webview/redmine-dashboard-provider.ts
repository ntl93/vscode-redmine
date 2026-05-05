import * as vscode from "vscode";
import { RedmineConfig } from "../definitions/redmine-config";
import { Issue } from "../redmine/models/issue";
import { IssueStatus as RedmineIssueStatus } from "../redmine/models/issue-status";
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

interface LogTimeModalData {
  issue: Issue;
  spentOn: string | null;
  statuses: RedmineIssueStatus[];
  timeEntries: TimeEntryRecord[];
  currentUserId: number | null;
  defaultActivityId: number | null;
}

const ALLOWED_MODAL_STATUS_NAMES = new Set([
  "new",
  "in progress",
  "feedback",
  "closed",
]);

const sortAndFilterModalStatuses = (
  statuses: RedmineIssueStatus[]
): RedmineIssueStatus[] => {
  const order = ["new", "in progress", "feedback", "closed"];
  return statuses
    .filter((status) => ALLOWED_MODAL_STATUS_NAMES.has(status.name.trim().toLowerCase()))
    .sort((left, right) => {
      const leftIndex = order.indexOf(left.name.trim().toLowerCase());
      const rightIndex = order.indexOf(right.name.trim().toLowerCase());
      return leftIndex - rightIndex;
    });
};

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
  isClosed: boolean;
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

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
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
  private _lastDashboardData: DashboardData | null = null;
  private _currentModalData: LogTimeModalData | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

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
        case "openIssueForLogTime":
          await this._openLogTimeModal(message.issueId, message.spentOn ?? null);
          break;
        case "closeLogTimeModal":
          this._currentModalData = null;
          await this._refreshDashboard();
          break;
        case "logTime":
          await this._logTime(message);
          break;
        case "updateTimeEntry":
          await this._updateTimeEntry(message);
          break;
        case "deleteTimeEntry":
          await this._deleteTimeEntry(message);
          break;
        case "changeStatus":
          await this._changeStatus(message);
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
            isClosed: false,
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
          isClosed: !!issueDetails && issueDetails.status.name === "Closed",
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

  private async _openLogTimeModal(issueId: number, spentOn: string | null): Promise<void> {
    if (!this._currentServer || !issueId) return;

    try {
      const [issueResponse, userResponse, activitiesResponse, statusesResponse, timeEntries] =
        await Promise.all([
          this._currentServer.getIssueById(issueId),
          this._currentServer.getCurrentUser(),
          this._currentServer.getTimeEntryActivities(),
          this._currentServer.getIssueStatuses(),
          this._currentServer.getTimeEntriesByIssue(issueId),
        ]);

      this._currentModalData = {
        issue: issueResponse.issue,
        spentOn,
        statuses: sortAndFilterModalStatuses(statusesResponse.issue_statuses || []),
        timeEntries,
        currentUserId: userResponse.id,
        defaultActivityId: activitiesResponse.time_entry_activities?.[0]?.id ?? null,
      };
      this._rerenderDashboard();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open time log modal: ${errorToString(error)}`);
    }
  }

  private async _logTime(message: {
    issueId: number;
    activityId?: number;
    hours: string;
    comments?: string;
    spentOn?: string;
  }): Promise<void> {
    if (!this._currentServer) return;
    try {
      const activityId =
        message.activityId || this._currentModalData?.defaultActivityId || 0;
      if (!activityId) {
        throw new Error("No time entry activity available");
      }
      await this._currentServer.addTimeEntry(
        message.issueId,
        activityId,
        message.hours,
        message.comments || "",
        message.spentOn
      );
      vscode.window.showInformationMessage(`Time entry logged for issue #${message.issueId}`);
      await this._refreshDashboard();
      if (this._currentModalData?.issue.id === message.issueId) {
        await this._openLogTimeModal(message.issueId, message.spentOn ?? null);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to log time: ${errorToString(error)}`);
    }
  }

  private async _updateTimeEntry(message: {
    timeEntryId: number;
    activityId?: number;
    hours?: string;
    comments?: string;
    spentOn?: string;
  }): Promise<void> {
    if (!this._currentServer) return;
    try {
      await this._currentServer.updateTimeEntry(
        message.timeEntryId,
        message.activityId,
        message.hours,
        message.comments || "",
        message.spentOn
      );
      vscode.window.showInformationMessage(`Time entry #${message.timeEntryId} updated`);
      await this._refreshDashboard();
      if (this._currentModalData) {
        await this._openLogTimeModal(this._currentModalData.issue.id, this._currentModalData.spentOn);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to update time entry: ${errorToString(error)}`);
    }
  }

  private async _deleteTimeEntry(message: { timeEntryId: number }): Promise<void> {
    if (!this._currentServer) return;
    try {
      await this._currentServer.deleteTimeEntry(message.timeEntryId);
      vscode.window.showInformationMessage(`Time entry #${message.timeEntryId} deleted`);
      await this._refreshDashboard();
      if (this._currentModalData) {
        await this._openLogTimeModal(this._currentModalData.issue.id, this._currentModalData.spentOn);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to delete time entry: ${errorToString(error)}`);
    }
  }

  private async _changeStatus(message: { issueId: number; statusId: number }): Promise<void> {
    if (!this._currentServer || !message.issueId) return;
    try {
      const response = await this._currentServer.getIssueById(message.issueId);
      await this._currentServer.setIssueStatus(response.issue, message.statusId);
      vscode.window.showInformationMessage(`Issue #${message.issueId} status changed`);
      await this._refreshDashboard();
      if (this._currentModalData?.issue.id === message.issueId) {
        await this._openLogTimeModal(message.issueId, this._currentModalData.spentOn);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to change status: ${errorToString(error)}`);
    }
  }

  private _rerenderDashboard(): void {
    if (!this.panel || !this._lastDashboardData) return;
    this._updateWebview(this._lastDashboardData);
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

    this._lastDashboardData = data;

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
            <div class="issue-actions">
              <button class="log-time-btn" data-issue-id="${issue.id}">Log Time</button>
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
                   <td class="worktime-day-cell ${report.days[index].weekendClass}" data-date="${report.days[index].date}"${hours > 0 ? ' data-has-entry="true"' : ''}>
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
              : row.isClosed
                ? `<span class="worktime-closed-label"><s>${escapeHtml(row.label)}</s></span>`
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

  private _buildLogTimeModalHtml(modal: LogTimeModalData): string {
    const defaultDate = modal.spentOn ?? new Date().toISOString().slice(0, 10);
    const statusOptions = modal.statuses
      .map(
        (status) =>
          `<option value="${status.id}"${status.id === modal.issue.status.id ? " selected" : ""}>${escapeHtml(status.name)}</option>`
      )
      .join("");
    const entryCards = modal.timeEntries.length
      ? modal.timeEntries
          .map(
            (entry) => `
              <div class="modal-entry" data-entry-id="${entry.id}" data-editable="${entry.user?.id === modal.currentUserId}">
                <div class="modal-entry-head">
                  <div>
                    <div class="modal-entry-title">#${entry.id}</div>
                    <div class="modal-entry-meta">${escapeHtml(entry.user?.name ?? "Unknown")}</div>
                  </div>
                  <button class="modal-button danger" data-delete-entry="${entry.id}" ${entry.user?.id === modal.currentUserId ? "" : "disabled"}>Delete</button>
                </div>
                <div class="modal-entry-meta">${escapeHtml(entry.spent_on)} · ${escapeHtml(entry.hours)} h</div>
                <div style="margin-top:10px;">
                  <textarea class="modal-textarea" data-entry-comments="${entry.id}" ${entry.user?.id === modal.currentUserId ? "" : "readonly"}>${escapeHtml(entry.comments || "")}</textarea>
                </div>
                ${entry.user?.id === modal.currentUserId ? `
                  <div class="modal-form-row compact" style="margin-top:10px;">
                    <input class="modal-input" type="number" min="0" step="0.1" data-entry-hours="${entry.id}" value="${escapeHtml(entry.hours)}" />
                    <input class="modal-input" type="date" data-entry-date="${entry.id}" value="${escapeHtml(entry.spent_on)}" />
                  </div>
                  <div class="modal-actions">
                    <button class="modal-button primary" data-update-entry="${entry.id}">Update</button>
                  </div>` : ""}
              </div>`
          )
          .join("")
      : `<div class="modal-empty">No time entries for this issue.</div>`;

    return `
      <div id="logTimeModal" class="modal-backdrop" data-issue-id="${modal.issue.id}">
        <div class="modal-card" role="dialog" aria-modal="true">
          <div class="modal-card-header">
            <div>
              <div class="modal-title">#${modal.issue.id} ${escapeHtml(modal.issue.subject)}</div>
              <div class="modal-subtitle">${escapeHtml(modal.issue.project?.name ?? "")}</div>
            </div>
            <button class="modal-close-btn" id="modalCloseBtn">Close</button>
          </div>

          <div class="modal-grid">
            <div class="modal-section">
              <div class="modal-section-title">Log Time</div>
              <div class="modal-form-row compact">
                <input id="modalHours" class="modal-input" type="number" min="0" step="0.1" placeholder="Hours" />
                <input id="modalSpentOn" class="modal-input" type="date" value="${defaultDate}" />
              </div>
              <div style="margin-top:10px;">
                <textarea id="modalComments" class="modal-textarea" placeholder="Comments"></textarea>
              </div>
              <div class="modal-actions">
                <button id="modalLogTimeBtn" class="modal-button primary">Log time</button>
              </div>
            </div>

            <div class="modal-section">
              <div class="modal-section-title">Change Status</div>
              <div class="modal-form-row compact">
                <select id="modalStatus" class="modal-select">
                  ${statusOptions}
                </select>
                <button id="modalStatusBtn" class="modal-button">Apply</button>
              </div>
            </div>

            <div class="modal-section">
              <div class="modal-section-title">Existing Time Entries</div>
              ${entryCards}
            </div>
          </div>
        </div>
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
    const modalHtml = this._currentModalData ? this._buildLogTimeModalHtml(this._currentModalData) : "";

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
        .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #e1e4e8; }
        .header h2 { font-size:16px; font-weight:600; }
        .server-info { background:#f6f8fa; border:1px solid #e1e4e8; border-radius:6px; padding:8px 12px; margin-bottom:16px; font-size:12px; }
        .server-info a { color:#0366d6; text-decoration:none; }
        .error-banner { background:#ffeef0; border:1px solid #d73a49; border-radius:6px; padding:12px; margin-bottom:16px; color:#cb2431; }
        .section-title { font-size:14px; font-weight:600; margin-bottom:8px; }
        .issue-card { border:1px solid #e1e4e8; border-radius:6px; padding:12px; margin-bottom:8px; cursor:pointer; }
        .issue-card:hover { background:#f6f8fa; border-color:#0366d6; }
        .issue-header { display:flex; align-items:baseline; gap:8px; margin-bottom:6px; }
        .issue-id { font-weight:600; color:#586069; font-size:12px; }
        .issue-subject { font-weight:600; flex:1; }
        .issue-meta, .issue-details { display:flex; gap:4px; flex-wrap:wrap; font-size:11px; color:#6a737d; }
        .badge { display:inline-block; padding:1px 8px; border-radius:12px; font-size:11px; font-weight:500; }
        .badge.tracker, .badge.status { background:#e6f3ff; color:#0366d6; }
        .badge.priority { background:#fff8c5; color:#735c0f; }
        .refresh-btn, .log-time-btn, .open-browser-btn, .modal-close-btn, .modal-button { cursor:pointer; }
        .refresh-btn { background:none; border:1px solid #e1e4e8; border-radius:6px; padding:4px 10px; font-size:12px; color:#586069; }
        .no-issues { text-align:center; padding:24px; color:#6a737d; }
        .worktime-report { margin-bottom:20px; padding:12px; border:1px solid #e1e4e8; border-radius:8px; background:#fafbfc; }
        .worktime-report-header { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:12px; flex-wrap:wrap; }
        .worktime-report-period { font-size:12px; color:#586069; margin-top:2px; }
        .worktime-report-controls { display:flex; flex-direction:column; gap:8px; align-items:flex-end; }
        .worktime-month-nav { display:flex; align-items:center; gap:8px; }
        .report-nav-btn { background:#fff; border:1px solid #d0d7de; border-radius:6px; padding:4px 8px; cursor:pointer; font-size:12px; color:#24292e; }
        .report-nav-btn:hover { background:#f3f4f6; }
        .worktime-month-label { min-width:180px; text-align:center; font-size:12px; color:#24292e; }
        .worktime-project-select { min-width:220px; border:1px solid #d0d7de; border-radius:6px; padding:5px 8px; font-size:12px; color:#24292e; background:#fff; }
        .worktime-summary-chips { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
        .worktime-summary-chip { display:inline-flex; align-items:center; border:1px solid #e1e4e8; border-radius:999px; background:#fff; padding:3px 10px; font-size:11px; color:#586069; }
        .worktime-table-wrap { overflow-x:auto; border:1px solid #e1e4e8; border-radius:8px; background:#fff; }
        .worktime-table { width:100%; min-width:100%; border-collapse:collapse; table-layout:fixed; }
        .worktime-table th,
        .worktime-table td { border-right:1px solid #e1e4e8; border-bottom:1px solid #e1e4e8; padding:4px 6px; text-align:center; white-space:nowrap; }
        .worktime-table th.worktime-label-col { position:sticky; left:0; z-index:2; text-align:left; width:420px; min-width:420px; max-width:420px; background:#fff; white-space:normal; overflow-wrap:anywhere; word-break:break-word; vertical-align:top; line-height:1.3; }
        .worktime-table .worktime-total-col { position:sticky; left:420px; z-index:1; width:96px; min-width:96px; max-width:96px; background:#fff; }
        .worktime-day-header { min-width:44px; font-size:11px; line-height:1.1; background:#f8f9fa; }
        .worktime-day-number { display:block; font-weight:600; }
        .worktime-day-weekday { display:block; color:#6a737d; margin-top:2px; }
        .worktime-day-cell,
        .worktime-day-total { min-width:44px; font-variant-numeric:tabular-nums; }
        .weekend-saturday { background:#eef2ff; }
        .weekend-sunday { background:#fff1f2; }
        .worktime-summary-row { background:#111827; color:#fff; }
        .worktime-summary-row th.worktime-label-col,
        .worktime-summary-row .worktime-total-col,
        .worktime-summary-row td { background:#111827; color:#fff; border-color:#2d3748; }
        .worktime-summary-label { font-weight:700; }
        .worktime-closed-label { color:#6a737d; }
        .worktime-closed-label s { color:#999; }
        .worktime-entry-row-clickable { cursor:pointer; }
        .worktime-entry-row:hover { background:#f6f8fa; }
        .worktime-entry-row:hover .worktime-label-col,
        .worktime-entry-row:hover .worktime-total-col { background:#f6f8fa; }
        .worktime-grand-total-row { background:#f6f8fa; font-weight:600; }
        .worktime-grand-total-row .worktime-label-col,
        .worktime-grand-total-row .worktime-total-col { background:#f6f8fa; }
        .issue-actions { display:flex; gap:8px; margin-top:8px; }
        .log-time-btn, .open-browser-btn, .modal-close-btn, .modal-button { border:1px solid #d0d7de; border-radius:6px; background:#fff; font-size:12px; color:#24292e; }
        .log-time-btn, .open-browser-btn { padding:4px 10px; }
        .modal-backdrop { position:fixed; inset:0; background:rgba(15,23,42,0.55); display:flex; align-items:center; justify-content:center; z-index:1000; padding:24px; }
        .modal-backdrop.hidden { display:none; }
        .modal-card { width:min(520px, 100%); max-height:min(72vh, 680px); overflow:auto; background:#fff; border-radius:14px; box-shadow:0 20px 60px rgba(15,23,42,0.35); border:1px solid #e5e7eb; padding:14px; }
        .modal-card-header { display:flex; justify-content:space-between; gap:16px; margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid #e5e7eb; }
        .modal-title { font-size:15px; font-weight:700; margin-bottom:4px; }
        .modal-subtitle { font-size:12px; color:#64748b; }
        .modal-grid { display:grid; grid-template-columns:1fr; gap:14px; }
        .modal-section { border:1px solid #e5e7eb; border-radius:10px; padding:12px; background:#fafafa; }
        .modal-section-title { font-size:13px; font-weight:700; margin-bottom:10px; }
        .modal-form-row { display:grid; grid-template-columns:1fr 120px 120px; gap:10px; }
        .modal-form-row.compact { grid-template-columns:1fr 100px; }
        .modal-input, .modal-select, .modal-textarea { width:100%; border:1px solid #d1d5db; border-radius:8px; padding:8px 10px; background:#fff; font-size:13px; }
        .modal-textarea { min-height:72px; resize:vertical; }
        .modal-actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
        .modal-button.primary { background:#2563eb; border-color:#2563eb; color:#fff; }
        .modal-button.danger { border-color:#dc2626; color:#dc2626; }
        .modal-entry { padding:10px; border:1px solid #e5e7eb; border-radius:8px; background:#fff; margin-bottom:10px; }
        .modal-entry-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:12px; }
        .modal-entry-title { font-weight:600; font-size:12px; }
        .modal-entry-meta { font-size:11px; color:#64748b; margin-top:4px; }
        .modal-empty { color:#64748b; font-size:12px; padding:8px 0; }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>Redmine Dashboard</h2>
        <button class="refresh-btn" id="refreshBtn">&#x21bb; Refresh</button>
      </div>
      ${serverUrl ? `<div class="server-info">Connected to: <a href="${serverUrl}" id="openServerLink" target="_blank">${serverUrl}</a></div>` : ""}
      ${errorHtml}
      ${worktimeReportHtml}
      ${modalHtml}
      <div class="section-title">Issues Assigned to Me (${issuesCount})</div>
      ${issuesHtml || `<div class="no-issues">No open issues assigned to you.</div>`}
      <script>
        const vscodeApi = acquireVsCodeApi();
        document.getElementById('refreshBtn')?.addEventListener('click', () => vscodeApi.postMessage({ type: 'refresh' }));
        document.getElementById('openServerLink')?.addEventListener('click', (e) => { e.preventDefault(); vscodeApi.postMessage({ type: 'openExternal', url: ${JSON.stringify(serverUrl)} }); });
        document.querySelectorAll('[data-report-action]').forEach((button) => button.addEventListener('click', () => vscodeApi.postMessage({ type: button.getAttribute('data-report-action') })));
        document.querySelectorAll('.worktime-entry-row[data-issue-id]').forEach((row) => row.addEventListener('click', () => { const issueId = parseInt(row.getAttribute('data-issue-id') || '', 10); if (!Number.isNaN(issueId)) vscodeApi.postMessage({ type: 'openIssueForLogTime', issueId }); }));
        document.querySelectorAll('.worktime-day-cell[data-has-entry="true"]').forEach((cell) => cell.addEventListener('click', (e) => { e.stopPropagation(); const row = cell.closest('tr'); const issueId = row ? parseInt(row.getAttribute('data-issue-id') || '', 10) : NaN; const date = cell.getAttribute('data-date'); if (!Number.isNaN(issueId) && date) vscodeApi.postMessage({ type: 'openIssueForLogTime', issueId, spentOn: date }); }));
        document.querySelectorAll('.log-time-btn').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); const issueId = parseInt(btn.getAttribute('data-issue-id') || '', 10); if (!Number.isNaN(issueId)) vscodeApi.postMessage({ type: 'openIssueForLogTime', issueId }); }));
        document.querySelectorAll('.open-browser-btn').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); const issueId = parseInt(btn.getAttribute('data-issue-id') || '', 10); if (!Number.isNaN(issueId)) vscodeApi.postMessage({ type: 'openIssue', issueId }); }));
        const modalBackdrop = document.getElementById('logTimeModal');
        document.getElementById('modalCloseBtn')?.addEventListener('click', () => vscodeApi.postMessage({ type: 'closeLogTimeModal' }));
        document.getElementById('modalLogTimeBtn')?.addEventListener('click', () => { const issueId = Number(modalBackdrop?.dataset.issueId || '0'); const activityId = 0; const hours = document.getElementById('modalHours').value; const spentOn = document.getElementById('modalSpentOn').value; const comments = document.getElementById('modalComments').value; if (!issueId || !hours) return; vscodeApi.postMessage({ type: 'logTime', issueId, activityId, hours, comments, spentOn }); });
        document.getElementById('modalStatusBtn')?.addEventListener('click', () => { const issueId = Number(modalBackdrop?.dataset.issueId || '0'); const statusId = Number(document.getElementById('modalStatus').value); if (!issueId || !statusId) return; vscodeApi.postMessage({ type: 'changeStatus', issueId, statusId }); });
        document.querySelectorAll('[data-update-entry]').forEach((btn) => btn.addEventListener('click', () => { const entryId = Number(btn.getAttribute('data-update-entry')); const hoursInput = document.querySelector('[data-entry-hours="' + entryId + '"]'); const commentsInput = document.querySelector('[data-entry-comments="' + entryId + '"]'); const dateInput = document.querySelector('[data-entry-date="' + entryId + '"]'); vscodeApi.postMessage({ type: 'updateTimeEntry', timeEntryId: entryId, hours: hoursInput?.value || undefined, comments: commentsInput?.value || undefined, spentOn: dateInput?.value || undefined }); }));
        document.querySelectorAll('[data-delete-entry]').forEach((btn) => btn.addEventListener('click', () => { const entryId = Number(btn.getAttribute('data-delete-entry')); vscodeApi.postMessage({ type: 'deleteTimeEntry', timeEntryId: entryId }); }));
      </script>
    </body>
    </html>`;
  }
}
