# 阶段 3 第 52 批（累计第 72 批）：Android PCM 采集层

新增 16 kHz 单声道 PCM16 AudioRecord 适配器与 5 秒分片 pump。停止排空已读尾段，不足整毫秒补零少于 1 ms；设备切换、系统静音、读取/写盘失败和权限变化不触发自动开麦或丢失数据后的伪成功。输入 PCM 暂存使用后清零，写盘独立于上传。

验证：8 项 PCM 测试、9 项传输回归、Debug 构建与设计 token 检查通过。尚未实际开麦；前台服务和 UI 下一批接入，锁屏/蓝牙/来电需用户设备实测。API 边界依据 [Android 官方说明](https://developer.android.com/media/platform/sharing-audio-input)。
