import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn(() => ({
  status: 0,
  stdout: "[]",
  stderr: "",
}));

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const { D1WranglerClient, npxExecutable, normalizeWindowsCommandSql, quoteWindowsArg } = await import(
  "./d1Wrangler.js"
);

describe("D1WranglerClient spawn", () => {
  beforeEach(() => {
    spawnSyncMock.mockClear();
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "[]",
      stderr: "",
    });
  });

  it("passes SQL to wrangler without splitting arguments", () => {
    const client = new D1WranglerClient({ remote: true });
    const sql =
      "SELECT status, type, COUNT(*) AS count FROM jobs WHERE status IN ('pending', 'running') GROUP BY status, type;";

    client.execute(sql);

    expect(spawnSyncMock).toHaveBeenCalledOnce();
    if (process.platform === "win32") {
      const [command, opts] = spawnSyncMock.mock.calls[0] as [string, { shell: boolean }];
      expect(typeof command).toBe("string");
      expect(opts.shell).toBe(true);
      expect(command).toContain("--command");
      expect(command).toContain("GROUP BY status, type");
      expect(command).not.toMatch(/GROUP BY status, type;/);
      expect(command).toContain("--remote");
      expect(command).toContain("production");
    } else {
      const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
        string,
        string[],
        { shell: boolean },
      ];
      expect(cmd).toBe(npxExecutable());
      expect(opts.shell).toBe(false);
      expect(args).toContain("--command");
      const commandIdx = args.indexOf("--command");
      expect(args[commandIdx + 1]).toBe(sql);
      expect(args).toContain("--remote");
      expect(args).toContain("--env");
      expect(args).toContain("production");
    }
  });

  it("strips trailing semicolons for Windows command SQL", () => {
    expect(normalizeWindowsCommandSql("SELECT 1;;  ")).toBe("SELECT 1");
  });

  it("quotes Windows args with spaces for shell command lines", () => {
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("has space")).toBe('"has space"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say ""hi"""');
  });

  it("uses platform-appropriate spawn options for executeFile", () => {
    const client = new D1WranglerClient({ remote: false });
    client.executeFile("C:\\temp\\query.sql");

    expect(spawnSyncMock).toHaveBeenCalledOnce();
    if (process.platform === "win32") {
      const [command, opts] = spawnSyncMock.mock.calls[0] as [string, { shell: boolean }];
      expect(typeof command).toBe("string");
      expect(opts.shell).toBe(true);
      expect(command).toContain("--file");
      expect(command).toContain("C:\\temp\\query.sql");
      expect(command).toContain("--local");
    } else {
      const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
        string,
        string[],
        { shell: boolean },
      ];
      expect(cmd).toBe(npxExecutable());
      expect(opts.shell).toBe(false);
      expect(args).toContain("--file");
      expect(args[args.indexOf("--file") + 1]).toBe("C:\\temp\\query.sql");
      expect(args).toContain("--local");
    }
  });
});
