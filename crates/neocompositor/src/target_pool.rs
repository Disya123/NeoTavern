//! Bounded render-target pool (RFC §50). CPU-side accounting only.

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct TargetId(pub u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetPoolError {
    Exhausted,
}

pub struct TargetPool {
    cap: usize,
    next_id: u32,
    in_use: Vec<TargetId>,
    free: Vec<TargetId>,
}

impl TargetPool {
    pub fn new(cap: usize) -> Self {
        assert!(cap > 0, "TargetPool cap must be at least 1");
        Self {
            cap,
            next_id: 1,
            in_use: Vec::new(),
            free: Vec::new(),
        }
    }

    pub fn in_use_count(&self) -> usize {
        self.in_use.len()
    }

    pub fn acquire(&mut self) -> Result<TargetId, TargetPoolError> {
        if let Some(id) = self.free.pop() {
            self.in_use.push(id);
            return Ok(id);
        }
        if self.in_use.len() >= self.cap {
            return Err(TargetPoolError::Exhausted);
        }
        let id = TargetId(self.next_id);
        self.next_id += 1;
        self.in_use.push(id);
        Ok(id)
    }

    pub fn release(&mut self, id: TargetId) {
        if let Some(idx) = self.in_use.iter().position(|open| *open == id) {
            self.in_use.remove(idx);
            self.free.push(id);
        }
    }
}
