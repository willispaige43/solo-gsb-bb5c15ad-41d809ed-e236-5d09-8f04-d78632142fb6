# 显微图像纹理分区审阅台

本地运行的显微图像纹理分区工具：上传灰度显微图并设置像素尺度，系统计算局部梯度
方向场，按**方向一致性 + 梯度强度阈值**生成候选纹理区域，用**分水岭式拆分**避免
相邻区域粘连，并自动标出**低置信度边界**。网页端支持原图 / 方向场 / 区域轮廓三层
叠加查看，调整阈值后可将分区结果**带版本号保存**（SQLite 持久化）。

## 快速开始（一条命令）

```bash
docker compose up --build
```

启动后在浏览器访问：

```
http://localhost:8080
```

数据（SQLite 库 + 上传的图像）保存在名为 `app_data` 的 Docker 卷中，容器重建不丢失。
停止：`docker compose down`。

### 本地开发（不用 Docker）

要求 Node.js ≥ 22.5（使用内置 `node:sqlite`）：

```bash
npm install
npm start          # 等价于 node --experimental-sqlite server.js
# 访问 http://localhost:8080
```

环境变量：`PORT`（默认 8080）、`DATA_DIR`（默认 `./data`，容器内为 `/data`）。

## 使用流程

1. **上传图像**：选择 PNG/JPEG 灰度显微图，填写像素尺度（µm/px）。没有样本时可点
   “生成示例图像”获得一张合成纹理图立即体验。超长边 >1024 的图会等比缩到处理
   分辨率，像素尺度自动换算。
2. **调阈值**：拖动滑块后点“分析（预览）”即时查看分区效果，不产生记录。
3. **叠加查看**：可分别开关原图、方向场（色相=主方向，饱和度=一致性）、区域填充、
   区域轮廓、低置信边界（黄色加粗点）。
4. **保存版本**：满意后点“保存为新版本”，同一图像的版本号自动递增；从下拉框可
   随时载入历史版本（参数与结果一并恢复）。
5. **区域统计**：面积（px 与 µm²）、质心、平均方向、平均一致性、低置信边界占比。

## 算法说明

| 步骤 | 方法 |
| --- | --- |
| 预处理 | 可分离高斯去噪（σ=1） |
| 梯度 | Sobel 算子 gx、gy |
| 方向场 | 结构张量 J（σ=2 平滑）：主方向 θ=½·atan2(2Jxy, Jxx−Jyy)，一致性 = √((Jxx−Jyy)²+4Jxy²)/(Jxx+Jyy) |
| 候选区域 | coherence ≥ 一致性阈值 且 平滑梯度强度 ≥ 强度阈值 |
| 防粘连 | 掩膜距离变换（Chamfer 1/√2）+ 分水岭浸没：从距离极大值生长，相遇处形成脊线拆开相邻区域 |
| 后处理 | 小于 minArea 的区域并入最大相邻区域；相邻区域平均方向差 < 合并方向差（默认 8°）时并回同一纹理 |
| 低置信边界 | 边界置信度 = 局部一致性 ×（与邻域方向差 / 90°）（与背景交界时仅取一致性），低于阈值标黄 |

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/images` | 上传（原始字节流；头 `X-File-Name`、`X-Pixel-Scale`） |
| POST | `/api/demo` | 生成演示图像 |
| GET | `/api/images` / `/api/images/:id` | 列表 / 元数据 |
| PATCH | `/api/images/:id` | 更新像素尺度 `{pixelScale}` |
| GET | `/api/images/:id/preview.png` | 灰度预览图 |
| GET | `/api/images/:id/orientation.png` | 方向场渲染图 |
| POST | `/api/images/:id/analyze` | 按给定阈值分析（不落库） |
| POST | `/api/images/:id/partitions` | 分析并保存为下一版本 |
| GET | `/api/images/:id/partitions` | 版本列表 |
| GET | `/api/images/:id/partitions/:v` | 读取指定版本 |

## 目录结构

```
server.js            Express 服务与路由
src/db.js            SQLite（node:sqlite）表结构
src/image.js         解码/灰度化/缩放/高斯滤波/PNG 编码
src/analysis.js      方向场、阈值掩膜、分水岭拆分、边界置信度
src/render.js        方向场 PNG 渲染
src/demo.js          合成演示样本
public/              单页网页（原图/方向场/轮廓叠加）
Dockerfile           node:22-alpine，纯 JS 依赖
docker-compose.yml   端口 8080 + app_data 数据卷
```
