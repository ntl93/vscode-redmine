import { Url, parse } from "url";
import * as http from "http";
import * as https from "https";
import { RedmineProject } from "./redmine-project";
import {
  IssueStatus,
  Membership,
  QuickUpdate,
  QuickUpdateResult,
} from "../controllers/domain";
import { TimeEntryActivity } from "./models/time-entry-activity";
import { NamedEntity } from "./models/named-entity";
import { Project } from "./models/project";
import { TimeEntry } from "./models/time-entry";
import { Issue } from "./models/issue";
import { IssueStatus as RedmineIssueStatus } from "./models/issue-status";
import { Membership as RedmineMembership } from "./models/membership";

type HttpMethods = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface TimeEntryRecord {
  id: number;
  issue_id?: number;
  spent_on: string;
  hours: string;
  comments?: string;
  project?: NamedEntity;
  issue?: {
    id: number;
    subject?: string;
    project?: NamedEntity;
  };
  user?: NamedEntity;
  activity?: NamedEntity;
}

interface TimeEntryCollectionResponse {
  time_entries: TimeEntryRecord[];
  total_count?: number;
  offset?: number;
  limit?: number;
}

const REDMINE_API_KEY_HEADER_NAME = "X-Redmine-API-Key";
const ISSUE_BATCH_SIZE = 100;

export interface RedmineServerConnectionOptions {
  /**
   * @example https://example.com
   * @example http://example.com:8080
   * @example https://example.com:8443/redmine
   * @example http://example.com/redmine
   */
  address: string;
  /**
   * @example 7215ee9c7d9dc229d2921a40e899ec5f
   */
  key: string;
  /**
   * @default false
   */
  rejectUnauthorized?: boolean;
  /**
   * @example { "Authorization": "Basic YTph" }
   */
  additionalHeaders?: { [key: string]: string };
}

interface RedmineServerOptions extends RedmineServerConnectionOptions {
  url: Url;
}

export class RedmineOptionsError extends Error {
  name = "RedmineOptionsError";
}

export class RedmineServer {
  options!: RedmineServerOptions;

  private timeEntryActivities: TimeEntryActivity[] | null = null;

  get request() {
    return this.options.url.protocol === "https:"
      ? https.request
      : http.request;
  }

  private validateOptions(options: RedmineServerConnectionOptions): void {
    if (!options.address) {
      throw new RedmineOptionsError("Address cannot be empty!");
    }
    if (!options.key) {
      throw new RedmineOptionsError("Key cannot be empty!");
    }
    const url = parse(options.address);
    if (["https:", "http:"].indexOf(url.protocol ?? "") === -1) {
      throw new RedmineOptionsError(
        "Address must have supported protocol (http/https)"
      );
    }
  }

  private setOptions(options: RedmineServerConnectionOptions) {
    this.options = {
      ...options,
      url: parse(options.address),
    };
    if (
      this.options.additionalHeaders === null ||
      this.options.additionalHeaders === undefined
    ) {
      this.options.additionalHeaders = {};
    }
  }

  constructor(options: RedmineServerConnectionOptions) {
    this.validateOptions(options);
    this.setOptions(options);
  }

  doRequest<T>(path: string, method: HttpMethods, data?: Buffer): Promise<T> {
    const { url, key, additionalHeaders, rejectUnauthorized } = this.options;
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      headers: {
        [REDMINE_API_KEY_HEADER_NAME]: key,
        ...additionalHeaders,
      },
      rejectUnauthorized: rejectUnauthorized,
      path: `${url.pathname}${path}`,
      method,
    };
    if (data) {
      (options.headers as Record<string, string | number>)["Content-Length"] =
        data.length;
      (options.headers as Record<string, string | number>)["Content-Type"] =
        "application/json";
    }

    return new Promise((resolve, reject) => {
      let incomingBuffer = Buffer.from("");
      const handleData = (_: http.IncomingMessage) => (incoming: Buffer) => {
        incomingBuffer = Buffer.concat([incomingBuffer, incoming]);
      };

      const handleEnd = (clientResponse: http.IncomingMessage) => () => {
        const { statusCode, statusMessage } = clientResponse;
        if (statusCode === 401) {
          reject(
            new Error(
              "Server returned 401 (perhaps your API Key is not valid, or your server has additional authentication methods?)"
            )
          );
          return;
        }
        if (statusCode === 403) {
          reject(
            new Error(
              "Server returned 403 (perhaps you haven't got permissions?)"
            )
          );
          return;
        }
        if (statusCode === 404) {
          reject(new Error("Resource doesn't exist"));
          return;
        }

        // TODO: Other errors handle
        if (statusCode! >= 400) {
          reject(new Error(`Server returned ${statusMessage}`));
          return;
        }

        if (incomingBuffer.length > 0) {
          try {
            const object = JSON.parse(incomingBuffer.toString("utf8"));
            resolve(object);
          } catch {
            reject(new Error("Couldn't parse Redmine response as JSON..."));
          }
          return;
        }

        // Using `doRequest` on the endpoints that return 204 should type as void/null
        resolve(null as unknown as T);
      };

      const clientRequest = this.request(options, (incoming) => {
        incoming.on("data", handleData(incoming));
        incoming.on("end", handleEnd(incoming));
      });

      const handleError = (error: Error) => {
        reject(
          new Error(`NodeJS Request Error (${error.name}): ${error.message}`)
        );
      };

      clientRequest.on("error", handleError);

      clientRequest.end(data);
    });
  }

  async getProjects(): Promise<RedmineProject[]> {
    const req = async (
      offset = 0,
      limit = 50,
      count: number | null = null,
      accumulator: RedmineProject[] = []
    ): Promise<RedmineProject[]> => {
      if (count && count <= offset) {
        return accumulator;
      }

      const [totalCount, result]: [number, RedmineProject[]] =
        await this.doRequest<{
          projects: Project[];
          total_count: number;
        }>(`/projects.json?limit=${limit}&offset=${offset}`, "GET").then(
          ({ total_count, projects }) => [
            total_count,
            projects.map(
              (proj) =>
                new RedmineProject(this, {
                  ...proj,
                })
            ),
          ]
        );

      return req(offset + limit, limit, totalCount, accumulator.concat(result));
    };

    return req();
  }

  getTimeEntryActivities(): Promise<{
    time_entry_activities: TimeEntryActivity[];
  }> {
    if (this.timeEntryActivities) {
      return Promise.resolve({
        time_entry_activities: this.timeEntryActivities,
      });
    }
    return this.doRequest<{
      time_entry_activities: TimeEntryActivity[];
    }>(`/enumerations/time_entry_activities.json`, "GET").then((response) => {
      if (response) {
        this.timeEntryActivities = response.time_entry_activities;
      }

      return response;
    });
  }

  addTimeEntry(
    issueId: number,
    activityId: number,
    hours: string,
    message: string
  ): Promise<unknown> {
    return this.doRequest<{ time_entry: TimeEntry }>(
      `/time_entries.json`,
      "POST",
      Buffer.from(
        JSON.stringify({
          time_entry: <TimeEntry>{
            issue_id: issueId,
            activity_id: activityId,
            hours,
            comments: message,
          },
        })
      )
    );
  }

  /**
   * Returns promise, that resolves to an issue
   * @param issueId ID of issue
   */
  getIssueById(issueId: number): Promise<{ issue: Issue }> {
    return this.doRequest(`/issues/${issueId}.json`, "GET");
  }

  /**
   * Returns promise that resolves to a list of issues matching the given IDs.
   * Requests are batched and processed concurrently to avoid overly long URLs.
   * @param issueIds Array of issue IDs to fetch
   */
  async getIssuesByIds(issueIds: number[]): Promise<Issue[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const batches: number[][] = [];
    for (let i = 0; i < issueIds.length; i += ISSUE_BATCH_SIZE) {
      batches.push(issueIds.slice(i, i + ISSUE_BATCH_SIZE));
    }

    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        const response = await this.doRequest<{ issues: Issue[] }>(
          `/issues.json?issue_id=${batch.join(",")}&limit=${ISSUE_BATCH_SIZE}&status_id=*`,
          "GET"
        );
        return response?.issues ?? [];
      })
    );

    return batchResults.flat();
  }

  /**
   * Returns promise, that resolves, when issue status is set
   */
  setIssueStatus(issue: Issue, statusId: number): Promise<unknown> {
    return this.doRequest<{ issue: Issue }>(
      `/issues/${issue.id}.json`,
      "PUT",
      Buffer.from(
        JSON.stringify({
          issue: {
            status_id: statusId,
          },
        }),
        "utf8"
      )
    );
  }

  issueStatuses: { issue_statuses: RedmineIssueStatus[] } | null = null;

  /**
   * Returns promise, that resolves to list of issue statuses in provided redmine server
   */
  getIssueStatuses(): Promise<{ issue_statuses: RedmineIssueStatus[] }> {
    if (this.issueStatuses === null || this.issueStatuses === undefined) {
      return this.doRequest<{ issue_statuses: RedmineIssueStatus[] }>(
        "/issue_statuses.json",
        "GET"
      ).then((obj) => {
        if (obj) {
          // Shouldn't change much; cache it.
          this.issueStatuses = obj;
        }

        return obj;
      });
    } else {
      return Promise.resolve(this.issueStatuses);
    }
  }

  async getIssueStatusesTyped(): Promise<IssueStatus[]> {
    const statuses = await this.getIssueStatuses();
    return statuses.issue_statuses.map((s) => new IssueStatus(s.id, s.name));
  }

  async getTimeEntries(options: {
    from: string;
    to: string;
    projectId?: number | string;
    userId?: number | string;
    limit?: number;
  }): Promise<TimeEntryRecord[]> {
    const limit = options.limit ?? 100;
    const allEntries: TimeEntryRecord[] = [];

    for (let offset = 0; ; offset += limit) {
      const query = new URLSearchParams({
        from: options.from,
        to: options.to,
        limit: String(limit),
        offset: String(offset),
        include: "issue,project,activity,user",
      });

      if (options.projectId !== undefined && options.projectId !== null) {
        query.set("project_id", String(options.projectId));
      }

      if (options.userId !== undefined && options.userId !== null) {
        query.set("user_id", String(options.userId));
      }

      const response = await this.doRequest<TimeEntryCollectionResponse>(
        `/time_entries.json?${query.toString()}`,
        "GET"
      );

      const entries = response?.time_entries || [];
      allEntries.push(...entries);

      if (entries.length === 0) {
        break;
      }

      if (
        response?.total_count !== undefined &&
        allEntries.length >= response.total_count
      ) {
        break;
      }

      if (entries.length < limit) {
        break;
      }
    }

    return allEntries;
  }

  async getMemberships(projectId: number): Promise<Membership[]> {
    const membershipsResponse = await this.doRequest<{
      memberships: RedmineMembership[];
    }>(`/projects/${projectId}/memberships.json`, "GET");

    return membershipsResponse.memberships.map((m) =>
      "user" in m
        ? new Membership(m.user.id, m.user.name)
        : new Membership(m.group.id, m.group.name, false)
    );
  }
  async applyQuickUpdate(quickUpdate: QuickUpdate): Promise<QuickUpdateResult> {
    await this.doRequest<void>(
      `/issues/${quickUpdate.issueId}.json`,
      "PUT",
      Buffer.from(
        JSON.stringify({
          issue: {
            status_id: quickUpdate.status.statusId,
            assigned_to_id: quickUpdate.assignee.id,
            notes: quickUpdate.message,
          },
        }),
        "utf8"
      )
    );
    const issueRequest = await this.getIssueById(quickUpdate.issueId);
    const issue = issueRequest.issue;
    const updateResult = new QuickUpdateResult();
    if (issue.assigned_to.id !== quickUpdate.assignee.id) {
      updateResult.addDifference("Couldn't assign user");
    }
    if (issue.status.id !== quickUpdate.status.statusId) {
      updateResult.addDifference("Couldn't update status");
    }
    return updateResult;
  }

  /**
   * Returns promise, that resolves to list of issues assigned to api key owner
   */
  getIssuesAssignedToMe(): Promise<{ issues: Issue[] }> {
    return this.doRequest<{ issues: Issue[] }>(
      "/issues.json?status_id=open&assigned_to_id=me",
      "GET"
    );
  }

  /**
   * Returns promise, that resolves to list of open issues for project
   */
  getOpenIssuesForProject(
    project_id: number | string,
    include_subproject = true
  ): Promise<{ issues: Issue[] }> {
    if (include_subproject) {
      return this.doRequest<{ issues: Issue[] }>(
        `/issues.json?status_id=open&project_id=${project_id}&subproject_id=!*`,
        "GET"
      );
    } else {
      return this.doRequest<{ issues: Issue[] }>(
        `/issues.json?status_id=open&project_id=${project_id}`,
        "GET"
      );
    }
  }

  compare(other: RedmineServer) {
    const headersEqual = (
      a: { [key: string]: string } | undefined,
      b: { [key: string]: string } | undefined
    ) => {
      const aObj = a ?? {};
      const bObj = b ?? {};
      const aKeys = Object.keys(aObj).sort();
      const bKeys = Object.keys(bObj).sort();
      return (
        aKeys.length === bKeys.length &&
        aKeys.every((k, i) => k === bKeys[i] && aObj[k] === bObj[k])
      );
    };
    return (
      this.options.address === other.options.address &&
      this.options.key === other.options.key &&
      this.options.rejectUnauthorized === other.options.rejectUnauthorized &&
      headersEqual(
        this.options.additionalHeaders,
        other.options.additionalHeaders
      )
    );
  }
}
