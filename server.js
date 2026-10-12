import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const workspaces = {
  obranding: path.resolve("D:/Cractise/NestJS/work/obranding-be-2"),
  ams: path.resolve("D:/Cractise/NestJS/work/OBD/obranding-be-2-feature-b2c-dev"),
  OBD2: path.resolve(
    "D:/Cractise/NestJS/work/OBD-service/obranding-b2c-service",
  ),
  FeOBD: path.resolve("D:/Cractise/NestJS/work/AppFEOBD"),
};

// Tạo danh sách project để dùng lại trong mô tả
const projectNames = Object.keys(workspaces).join(", ");

// ============================================================
// CẤU HÌNH DATABASE MYSQL
// ============================================================
// Mỗi service trong OBD2 có thể trỏ tới schema riêng, và port thật
// (theo .env của các service) là 3307, KHÔNG PHẢI 3306 mặc định.
// Thêm/sửa entry ở đây nếu bạn có thêm schema khác cần truy vấn.
const databases = {
  obranding: {
    host: "localhost",
    port: 3307,
    user: "root",
    password: "1234",
    database: "obranding", // order-service, product-service, seller-service... dùng chung schema này
  },
  obranding_b2c: {
    host: "localhost",
    port: 3307,
    user: "root",
    password: "1234",
    database: "obranding", // shipment-service dùng schema riêng này
  },
};

const databaseNames = Object.keys(databases).join(", ");

function resolveWorkspacePath(projectName, relativePath = "") {
  const baseDir = workspaces[projectName];
  if (!baseDir) {
    throw new Error(
      `Project '${projectName}' không tồn tại. Các project hiện có: ${Object.keys(workspaces).join(", ")}`,
    );
  }

  const targetPath = path.resolve(baseDir, relativePath);

  if (targetPath !== baseDir && !targetPath.startsWith(baseDir + path.sep)) {
    throw new Error("Path is outside workspace");
  }

  return targetPath;
}

// Cache pool theo từng database, tránh tạo lại connection pool mỗi lần gọi
const pools = {};

async function getMysqlPool(databaseKey = "obranding") {
  const config = databases[databaseKey];
  if (!config) {
    throw new Error(
      `Database '${databaseKey}' không tồn tại. Các database hiện có: ${databaseNames}`,
    );
  }

  if (!pools[databaseKey]) {
    pools[databaseKey] = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 10,
      maxIdle: 10,
      idleTimeout: 60000,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
  }
  return pools[databaseKey];
}

const server = new Server(
  {
    name: "local-project-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "listFiles",
        description:
          "Liệt kê danh sách file và thư mục trong project. Thư mục sẽ có dấu '/' ở cuối. Hãy dùng tool này để tìm hiểu cấu trúc code (src, controllers, services...).",
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              enum: Object.keys(workspaces),
              description: `Tên project muốn truy cập (${projectNames})`,
            },
            path: { type: "string" },
          },
          required: [],
        },
      },
      {
        name: "readFile",
        description:
          "Đọc nội dung của một file code cụ thể (ví dụ: .ts, .js, .json).",
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              enum: Object.keys(workspaces),
              description: `Tên project chứa file (${projectNames})`,
            },
            path: { type: "string" },
          },
          required: ["project", "path"],
        },
      },
      {
        name: "runMysql",
        description:
          `Chỉ sử dụng khi cần truy vấn dữ liệu thực tế từ database. Có thể chọn database qua tham số 'database' (${databaseNames}). Mặc định là 'obranding' nếu không truyền.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            database: {
              type: "string",
              enum: Object.keys(databases),
              description: `Schema muốn truy vấn (${databaseNames}). Mặc định: obranding`,
            },
          },
          required: ["query"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "listFiles") {
    if (!args.project) {
      return {
        content: [
          {
            type: "text",
            text: `Vui lòng chỉ định 'project' (${projectNames})`,
          },
        ],
        isError: true,
      };
    }
    const targetPath = resolveWorkspacePath(args.project, args.path || "");
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });

    // Loại bỏ các thư mục rác để Claude tập trung vào code logic
    const formattedList = entries
      .filter(
        (entry) =>
          !["node_modules", ".git", "dist", ".husky"].includes(entry.name),
      )
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: formattedList || "(thư mục trống hoặc chỉ chứa file bị ẩn)",
        },
      ],
    };
  } else if (name === "readFile") {
    const targetPath = resolveWorkspacePath(args.project, args.path);
    try {
      const stats = fs.statSync(targetPath);
      if (stats.isDirectory()) {
        throw new Error(
          "Đường dẫn là thư mục, hãy dùng listFiles để xem danh sách file bên trong.",
        );
      }
      const content = fs.readFileSync(targetPath, "utf-8");
      return {
        content: [{ type: "text", text: content }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Lỗi: ${error.message}` }],
        isError: true,
      };
    }
  } else if (name === "runMysql") {
    try {
      const dbPool = await getMysqlPool(args.database || "obranding");
      const [rows] = await dbPool.query(args.query);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(rows, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Lỗi SQL: ${error.message}` }],
        isError: true,
      };
    }
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("\n=== CẤU TRÚC DỰ ÁN NESTJS ===\n");

// Hàm log đơn giản hơn, chỉ log thư mục cấp 1 để tránh treo server
function logProjectStatus(name, dir) {
  try {
    if (fs.existsSync(dir)) {
      console.error(`\n=== CẤU TRÚC DỰ ÁN: ${name.toUpperCase()} ===\n`);
      const items = fs.readdirSync(dir, { withFileTypes: true });

      // Chỉ log thư mục cấp 1 để đảm bảo tốc độ khởi động
      for (const item of items) {
        if (
          ["node_modules", ".git", "dist", ".husky", ".next", "build"].includes(
            item.name,
          )
        )
          continue;
        console.error(`${item.isDirectory() ? "📁" : "📄"} ${item.name}`);

        // Nếu muốn xem sâu hơn 1 cấp cho src
        if (item.isDirectory() && item.name === "src") {
          const srcItems = fs
            .readdirSync(path.join(dir, item.name))
            .slice(0, 10);
          srcItems.forEach((s) => console.error(`  └── ${s}`));
        }
      }

      console.error(`✅ Project [${name.toUpperCase()}]: OK - ${dir}`);
    } else {
      console.error(`Lỗi: Thư mục không tồn tại tại đường dẫn: ${dir}`);
      console.error(
        `❌ Project [${name.toUpperCase()}]: KHÔNG TÌM THẤY - ${dir}`,
      );
    }
  } catch (error) {
    console.error(`Lỗi khi đọc cấu trúc project ${name}: ${error.message}`);
    console.error(
      `❌ Project [${name.toUpperCase()}]: Lỗi truy cập - ${error.message}`,
    );
  }
}

console.error("\n=== KIỂM TRA TRẠNG THÁI WORKSPACES ===\n");

Object.entries(workspaces).forEach(([name, dir]) => {
  logProjectStatus(name, dir);
});

console.error("\n=== Server connected and structure logged ===\n");
