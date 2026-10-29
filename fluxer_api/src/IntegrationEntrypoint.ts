// SPDX-License-Identifier: AGPL-3.0-or-later

import {initializeConfig} from '@app/api/Config';
import {initializeLogger} from '@app/api/Logger';
import {Config} from '@app/Config';
import {startIntegrationMain} from '@app/integration/IntegrationMain';
import {Logger} from '@app/Logger';

initializeConfig(Config);
initializeLogger(Logger);

startIntegrationMain()
	.then((shutdown) => {
		/** 收到退出信号后释放集成进程资源 */
		const stop = () => {
			void shutdown().finally(() => {
				process.exitCode = 0;
			});
		};
		process.once('SIGTERM', stop);
		process.once('SIGINT', stop);
	})
	.catch(() => {
		Logger.fatal('Fluxer integration startup failed');
		process.exitCode = 1;
	});
