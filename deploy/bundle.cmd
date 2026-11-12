@echo off
setlocal
set "ROOT=%~dp0.."
set "OUT=%~dp0..\legion-server.tar.gz"

echo Building archive from "%ROOT%"
if exist "%OUT%" del /q "%OUT%"

pushd "%ROOT%"
tar -czf "%OUT%" --exclude=node_modules --exclude=data --exclude=.git --exclude=.github .
popd

if not exist "%OUT%" (
  echo ERROR: archive was not created
  exit /b 1
)

echo.
echo Archive: %OUT%
echo.
echo Next steps (replace SERVER_IP):
echo   scp "%OUT%" root@SERVER_IP:/root/
echo   ssh root@SERVER_IP "mkdir -p /root/legion ^&^& tar -xzf /root/legion-server.tar.gz -C /root/legion ^&^& bash /root/legion/deploy/install.sh"
