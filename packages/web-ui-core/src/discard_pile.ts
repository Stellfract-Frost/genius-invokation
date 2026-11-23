// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { createSignal } from "solid-js";

/**
 * 页面层（不参与棋盘旋转）的弃牌堆按钮通过它请求打开棋盘内的列表弹窗。
 * 值为要查看的玩家下标，消费后置回 null。
 */
export const [discardPileRequest, setDiscardPileRequest] = createSignal<
  0 | 1 | null
>(null);
